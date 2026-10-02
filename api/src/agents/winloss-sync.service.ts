import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AgentService } from './agent.service';

/**
 * Attribution sync.
 *
 * Instead of editing each game's settlement code, this reads the settled bets
 * every game already writes and rolls their house result up to the owning
 * admin in agent_winloss. Attribution is idempotent on (game, ref), so running
 * it repeatedly is safe and re-settlements simply update the row.
 *
 * The house result per bet:
 *   sports / teenpatti : the ledger already holds the exposure, so
 *                        house_pl = liability - payout  (money kept minus paid)
 *   wheel              : house_pl = stake - payout
 * Positive means the house won (player lost); negative means the house paid.
 *
 * Driven by tick(), called on staff requests, so it needs no background timer —
 * the same reason the game round engines are request-driven on this host.
 */
@Injectable()
export class WinlossSyncService {
  private readonly log = new Logger(WinlossSyncService.name);
  private running = false;
  private lastRun = 0;

  constructor(
    private readonly ds: DataSource,
    private readonly agents: AgentService,
  ) {}

  /** Cheap to call often; does real work at most every few seconds. */
  async tick(force = false) {
    if (this.running) return;
    if (!force && Date.now() - this.lastRun < 4000) return;
    this.running = true;
    this.lastRun = Date.now();
    try {
      await this.syncSports();
      await this.syncWheel();
      await this.syncTeenPatti();
      await this.syncCasino();
    } catch (e: any) {
      this.log.warn('winloss sync: ' + e.message);
    } finally {
      this.running = false;
    }
  }

  /** Only bets not already attributed, so each run is small. */
  private async unattributed(table: string, game: string, cols: string) {
    return this.ds.query(
      `SELECT b.id AS ref, b.user_id, ${cols} FROM ${table} b
        WHERE b.status IN ('settled','void') AND NOT EXISTS (
          SELECT 1 FROM agent_winloss w WHERE w.game = ? AND w.ref = b.id
        ) LIMIT 500`,
      [game],
    ).catch(() => []);
  }

  private async syncSports() {
    const bets = await this.unattributed('sport_bet', 'sports', 'b.liability, b.payout, b.stake, b.result');
    for (const b of bets) {
      // void returns the liability, so house_pl is 0.
      const housePl = b.result === 'void' ? 0 : Number(b.liability) - Number(b.payout ?? 0);
      await this.agents.recordResult({ playerId: b.user_id, game: 'sports', ref: b.ref, stake: b.stake, housePl });
    }
  }

  private async syncTeenPatti() {
    const bets = await this.unattributed('tp_bet', 'teenpatti', 'b.liability, b.payout, b.stake, b.result');
    for (const b of bets) {
      const housePl = b.result === 'void' ? 0 : Number(b.liability) - Number(b.payout ?? 0);
      await this.agents.recordResult({ playerId: b.user_id, game: 'teenpatti', ref: b.ref, stake: b.stake, housePl });
    }
  }

  private async syncWheel() {
    const bets = await this.unattributed('wheel_bet', 'wheel', 'b.stake, b.payout, b.status');
    for (const b of bets) {
      const housePl = Number(b.stake) - Number(b.payout ?? 0);
      await this.agents.recordResult({ playerId: b.user_id, game: 'wheel', ref: b.ref, stake: b.stake, housePl });
    }
  }

  /**
   * InOut casino: the wallet ledger is the only record here, since rounds live
   * on the provider. Each inout entry nets to the house result already — a bet
   * is negative to the player, a win positive — so house_pl is the negation of
   * the player's net on that reference.
   */
  private async syncCasino() {
    const rows = await this.ds.query(
      `SELECT l.id AS ref, l.user_id, -l.delta AS house_pl, ABS(l.delta) AS stake
         FROM wallet_ledger l
        WHERE l.reference LIKE 'inout:%' AND NOT EXISTS (
          SELECT 1 FROM agent_winloss w WHERE w.game = 'casino' AND w.ref = l.id
        ) LIMIT 500`,
    ).catch(() => []);
    for (const r of rows) {
      await this.agents.recordResult({ playerId: r.user_id, game: 'casino', ref: r.ref, stake: r.stake, housePl: r.house_pl });
    }
  }
}
