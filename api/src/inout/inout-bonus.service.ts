import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { INOUT_API_BASE_DEFAULT, INOUT_OPERATOR_API_PATH } from './inout.constants';
import { operatorApiSignature, subOperatorId } from './util/inout-ids.util';

export interface FreebetConfig {
  count: string;
  chickenRoadConfig?: { betAmount: string; difficulty?: 'EASY' | 'MEDIUM' | 'HARD' | 'DAREDEVIL' };
  chickenRoadTwoConfig?: { betAmount: string; difficulty?: 'EASY' | 'MEDIUM' | 'HARD' | 'DAREDEVIL' };
  luckyMinesConfig?: { betAmount: string; minesCount: string };
  plinko1000Config?: { betAmount: string; risk?: 'LOW' | 'MEDIUM' | 'HIGH' };
  forestFortuneConfig?: { betAmount: string; risk?: 'EASY' | 'MEDIUM' | 'HARD' };
  cricketRoadConfig?: { betAmount: string; difficulty?: 'EASY' | 'MEDIUM' | 'HARD' | 'DAREDEVIL' };
  rabbitRoadConfig?: { betAmount: string; difficulty?: 'EASY' | 'MEDIUM' | 'HARD' | 'DAREDEVIL' };
  penguSportConfig?: { betAmount: string };
  aviaflyTwoConfig?: { betAmount: string };
  chickenCoinConfig?: { betAmount: string };
  jokersClashConfig?: { betAmount: string };
}

export interface CreateBonusInput {
  userId: string;
  bonusId: string;
  gameModes: string[];
  currency: string;
  expiresAt: string; // ISO 8601
  type: 'FREEBET';
  freebetConfig: FreebetConfig;
}

export type BonusStatus =
  | 'CREATED'
  | 'ACTIVE'
  | 'PENDING_COMPLETE'
  | 'COMPLETED'
  | 'EXPIRED'
  | 'CANCELLED'
  | 'EXPIRED_WHEN_ACTIVE';

@Injectable()
export class InoutBonusService {
  private readonly log = new Logger(InoutBonusService.name);
  private readonly operatorId: string;
  private readonly signature: string;
  private readonly apiBase: string;

  constructor(
    private readonly ds: DataSource,
    config: ConfigService,
  ) {
    const aggregatorId = config.getOrThrow<string>('INOUT_AGGREGATOR_ID');
    const subId = config.getOrThrow<string>('INOUT_SUB_ID');
    const secretKey = config.getOrThrow<string>('INOUT_SIGNATURE_KEY');

    // Bonus spec 2: the :operatorId path segment is the derived subOperatorId,
    // not the aggregatorId.
    this.operatorId = config.get<string>('INOUT_SUB_OPERATOR_ID') ?? subOperatorId(aggregatorId, subId);

    this.apiBase =
      (config.get<string>('INOUT_API_BASE') ?? INOUT_API_BASE_DEFAULT).replace(/\/$/, '') +
      INOUT_OPERATOR_API_PATH;

    // Bonus spec 1: constant per operator, so compute it once.
    this.signature = operatorApiSignature(this.operatorId, secretKey);
    this.log.log(`inout operator api ready for subOperatorId ${this.operatorId}`);
  }

  /**
   * Record the grant locally *before* calling the provider.
   *
   * The settlement webhook can credit real money, and it will only be honoured
   * if the bonusId matches a row here. Writing the row second would leave a
   * window where a settlement arrives for a bonus we have no record of. If the
   * remote call fails we roll our row back, since no bonus exists to settle.
   */
  async create(input: CreateBonusInput, opts: { hideFromStat?: boolean } = {}) {
    const betAmount = firstBetAmount(input.freebetConfig);

    await this.ds.query(
      `INSERT INTO inout_bonus
         (bonus_id, user_id, currency, game_modes, type, bet_amount, bonus_count,
          expires_at, hide_from_stat, config)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.bonusId,
        input.userId,
        input.currency,
        JSON.stringify(input.gameModes),
        input.type,
        betAmount,
        Number(input.freebetConfig.count),
        new Date(input.expiresAt),
        opts.hideFromStat ? 1 : 0,
        JSON.stringify(input.freebetConfig),
      ],
    );

    try {
      return await this.call('POST', `/bonuses/${this.operatorId}`, input);
    } catch (err) {
      await this.ds.query(`DELETE FROM inout_bonus WHERE bonus_id = ?`, [input.bonusId]);
      throw err;
    }
  }

  async list(filter: {
    userId?: string;
    gameModes?: string;
    currency?: string[];
    status?: BonusStatus[];
    page?: number;
    limit?: number;
  }) {
    const qs = new URLSearchParams();
    if (filter.userId) qs.set('filter[userId]', filter.userId);
    if (filter.gameModes) qs.set('filter[gameModes]', filter.gameModes);
    filter.currency?.forEach((c) => qs.append('filter[currency[]]', c));
    filter.status?.forEach((s) => qs.append('filter[status]', s));
    qs.set('pageable[page]', String(filter.page ?? 1));
    qs.set('pageable[limit]', String(filter.limit ?? 20));
    return this.call('GET', `/bonuses/${this.operatorId}?${qs}`);
  }

  async view(bonusId: string) {
    return this.call('GET', `/bonuses/${this.operatorId}/${bonusId}`);
  }

  async cancel(bonusId: string): Promise<{ status: boolean }> {
    const out = await this.call('DELETE', `/bonuses/${this.operatorId}/${bonusId}`);
    await this.ds.query(
      `UPDATE inout_bonus SET status = 'CANCELLED' WHERE bonus_id = ? AND settled_at IS NULL`,
      [bonusId],
    );
    return out;
  }

  private async call(method: string, path: string, body?: unknown): Promise<any> {
    const res = await fetch(`${this.apiBase}${path}`, {
      method,
      headers: {
        'X-REQUEST-SIGN': this.signature,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });

    const text = await res.text();
    if (!res.ok) {
      this.log.error(`${method} ${path} -> ${res.status} ${text}`);
      throw new Error(`inout bonus api ${res.status}`);
    }
    return text ? JSON.parse(text) : null;
  }
}

/** Every *Config variant carries betAmount; pull whichever one is present. */
function firstBetAmount(cfg: FreebetConfig): string | null {
  for (const [key, value] of Object.entries(cfg)) {
    if (key === 'count' || !value || typeof value !== 'object') continue;
    const amount = (value as { betAmount?: string }).betAmount;
    if (amount) return amount;
  }
  return null;
}