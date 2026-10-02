import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, QueryRunner } from 'typeorm';
import Decimal from 'decimal.js';

import { InoutAction, InoutBonusAction, InoutCode } from './inout.constants';
import { InoutRejection } from './filters/inout-exception.filter';
import { InoutSessionService, InoutSession } from './inout-session.service';
import { subOperatorId } from './util/inout-ids.util';
import { BadAmountError, formatAmount, parseAmount } from './util/money.util';
import {
  BetRequest,
  BonusWebhookRequest,
  InitRequest,
  InoutRequest,
  InoutResponse,
  RollbackRequest,
  WithdrawRequest,
} from './dto/webhook.dto';

/** MySQL duplicate-key error. Our idempotency guarantees rest on catching this. */
const MYSQL_DUPLICATE_ENTRY = 1062;

@Injectable()
export class InoutWebhookService {
  private readonly log = new Logger(InoutWebhookService.name);

  /**
   * Which operator identifiers we accept on an incoming webhook. The provider
   * uses the aggregatorId in some payloads and the derived subOperatorId in
   * others, so we accept either rather than rejecting live rounds over it.
   */
  private readonly operatorIds: Set<string>;

  constructor(
    private readonly ds: DataSource,
    private readonly sessions: InoutSessionService,
    config: ConfigService,
  ) {
    const aggregatorId = config.getOrThrow<string>('INOUT_AGGREGATOR_ID');
    const subId = config.getOrThrow<string>('INOUT_SUB_ID');
    this.operatorIds = new Set([
      aggregatorId,
      config.get<string>('INOUT_SUB_OPERATOR_ID') ?? subOperatorId(aggregatorId, subId),
    ]);
  }

  async handle(body: InoutRequest): Promise<InoutResponse> {
    this.assertOperator(body);
    switch (body.action) {
      case InoutAction.INIT:
        return this.init(body);
      case InoutAction.BET:
        return this.bet(body);
      case InoutAction.WITHDRAW:
        return this.withdraw(body);
      case InoutAction.ROLLBACK:
        return this.rollback(body);
      case InoutBonusAction.COMPLETE:
      case InoutBonusAction.EXPIRED_WHEN_ACTIVE:
        return this.settleBonus(body);
      default:
        throw new InoutRejection(InoutCode.UNKNOWN_ERROR, `unknown action ${(body as any)?.action}`);
    }
  }

  private assertOperator(body: InoutRequest) {
    const op = (body as any)?.data?.operator;
    if (op && !this.operatorIds.has(op)) {
      throw new InoutRejection(InoutCode.CHECKS_FAIL, `operator mismatch: ${op}`);
    }
  }

  // ---------------------------------------------------------------- init

  private async init(body: InitRequest): Promise<InoutResponse> {
    const activated = await this.sessions.activate(body.token);
    if (!activated) {
      throw new InoutRejection(InoutCode.INVALID_TOKEN, 'auth token unknown, used or expired');
    }
    const { session, sessionToken } = activated;

    if (body.data.gameMode !== session.game_mode) {
      throw new InoutRejection(InoutCode.CHECKS_FAIL, 'gameMode does not match launch');
    }
    if (body.data.currency !== session.currency) {
      throw new InoutRejection(InoutCode.CHECKS_FAIL, 'currency does not match launch');
    }

    const player = await this.loadPlayer(session.user_id, session.currency);

    return {
      code: InoutCode.OK,
      userId: String(player.user_id),
      nickname: player.nickname,
      balance: formatAmount(player.balance, session.currency),
      currency: session.currency,
      operator: [...this.operatorIds][0],
      ...(player.avatar_url ? { userAvatar: player.avatar_url } : {}),
      token: sessionToken,
    };
  }

  // ----------------------------------------------------------------- bet

  private async bet(body: BetRequest): Promise<InoutResponse> {
    const { transactionId, currency, user_id: userId, gameId } = body.data;
    const amount = this.amount(body.data.amount, currency);

    return this.inTx(async (qr) => {
      const replay = await this.replay(qr, transactionId);
      if (replay) return replay;

      const session = await this.requireSession(qr, body.token, userId, { enforceExpiry: true });

      // A rollback can legitimately land before its bet: the provider issues one
      // whenever a bet webhook times out, and our 200 may have been lost in
      // flight. If this bet was already voided, accept it without debiting.
      const voided = await qr.query(`SELECT 1 FROM inout_rollback_debit WHERE debit_id = ?`, [
        transactionId,
      ]);
      if (voided.length) {
        const bal = await this.balanceOf(qr, userId, currency);
        return this.record(qr, {
          transactionId,
          action: InoutAction.BET,
          session,
          userId,
          currency,
          amount,
          gameId,
          gameMode: body.gameMode,
          applied: false,
          balanceAfter: bal,
          response: { code: InoutCode.OK, balance: formatAmount(bal, currency) },
          raw: body,
        });
      }

      const wallet = await this.lockWallet(qr, userId, currency);
      if (wallet.balance.lt(amount)) {
        throw new InoutRejection(InoutCode.INSUFFICIENT_FUNDS, 'balance below stake');
      }

      const after = await this.move(qr, {
        userId,
        currency,
        current: wallet.balance,
        delta: amount.neg(),
        reference: `inout:bet:${transactionId}`,
        meta: { gameId, gameMode: body.gameMode },
      });

      return this.record(qr, {
        transactionId,
        action: InoutAction.BET,
        session,
        userId,
        currency,
        amount,
        gameId,
        gameMode: body.gameMode,
        applied: true,
        balanceAfter: after,
        response: { code: InoutCode.OK, balance: formatAmount(after, currency) },
        raw: body,
      });
    });
  }

  // ------------------------------------------------------------ withdraw

  private async withdraw(body: WithdrawRequest): Promise<InoutResponse> {
    const { transactionId, debitId, currency, user_id: userId, gameId, isFinished } = body.data;
    const result = this.amount(body.data.result, currency); // spec 3.3: stake already included
    const stake = this.amount(body.data.amount, currency);
    const coefficient = body.data.coefficient ? new Decimal(body.data.coefficient) : null;

    return this.inTx(async (qr) => {
      const replay = await this.replay(qr, transactionId);
      if (replay) return replay;

      // Payouts must survive an expired session — the provider retries for up to
      // 3 days and the player must still get paid, so we identify them from the
      // debit row when the token no longer resolves.
      const session = await this.sessions.resolve(body.token, qr);
      const debit = await this.findDebit(qr, debitId);
      if (!debit) {
        throw new InoutRejection(InoutCode.DEBIT_TRANSACTION_NOT_FOUND, `no bet ${debitId}`);
      }
      if (debit.user_id !== userId || debit.currency !== currency) {
        throw new InoutRejection(InoutCode.CHECKS_FAIL, 'debit does not belong to this player');
      }

      // If the round was already voided we must not also pay it out.
      const rolledBack = await qr.query(`SELECT 1 FROM inout_rollback_debit WHERE debit_id = ?`, [
        debitId,
      ]);
      if (rolledBack.length) {
        throw new InoutRejection(InoutCode.CHECKS_FAIL, `debit ${debitId} already rolled back`);
      }

      // A loss arrives as result = 0: recorded, but no money moves.
      const after = result.isZero()
        ? await this.balanceOf(qr, userId, currency)
        : await this.move(qr, {
            userId,
            currency,
            delta: result,
            reference: `inout:withdraw:${transactionId}`,
            meta: { gameId, debitId, coefficient: coefficient?.toString() },
          });

      if (isFinished && gameId) {
        await qr.query(`UPDATE inout_transaction SET is_finished = 1 WHERE game_id = ?`, [gameId]);
      }

      return this.record(qr, {
        transactionId,
        action: InoutAction.WITHDRAW,
        session,
        userId,
        currency,
        amount: stake,
        result,
        coefficient,
        debitId,
        gameId,
        gameMode: body.gameMode,
        isFinished,
        applied: !result.isZero(),
        balanceAfter: after,
        response: { code: InoutCode.OK, balance: formatAmount(after, currency) },
        raw: body,
      });
    });
  }

  // ------------------------------------------------------------ rollback

  private async rollback(body: RollbackRequest): Promise<InoutResponse> {
    const { transactionId, debitId, currency, user_id: userId, gameId, isFinished } = body.data;
    const amount = this.amount(body.data.amount, currency);

    return this.inTx(async (qr) => {
      const replay = await this.replay(qr, transactionId);
      if (replay) return replay;

      const session = await this.sessions.resolve(body.token, qr);
      const debit = await this.findDebit(qr, debitId);

      const settled = await qr.query(
        `SELECT 1 FROM inout_transaction WHERE action = 'withdraw' AND debit_id = ?`,
        [debitId],
      );
      // Refund only a debit that actually moved money and was never settled.
      const refund = Boolean(debit.applied) && settled.length === 0;
      if (!debit) {
        // No bet under that id. The provider expects an error here, and
        // DEBIT_TRANSACTION_NOT_FOUND is a final code so it will not be resent.
        //
        // The claim is still recorded, on its own connection, because this
        // transaction is about to roll back: if the bet turns up afterwards
        // (its webhook having timed out on the way in) the claim voids it.
        await this.claimRollbackOutOfBand(debitId, transactionId);
        throw new InoutRejection(InoutCode.DEBIT_TRANSACTION_NOT_FOUND, `no bet ${debitId}`);
      }

      // Claim this debit before any money moves. The primary key means a second
      // rollback for the same debit cannot commit, so the refund below can only
      // ever happen once no matter how often the provider resends.
      await qr.query(
        `INSERT INTO inout_rollback_debit (debit_id, transaction_id) VALUES (?, ?)`,
        [debitId, transactionId],
      );

      const after = refund
        ? await this.move(qr, {
            userId,
            currency,
            delta: amount,
            reference: `inout:rollback:${transactionId}`,
            meta: { gameId, debitId },
          })
        : await this.balanceOf(qr, userId, currency);

      if (isFinished && gameId) {
        await qr.query(`UPDATE inout_transaction SET is_finished = 1 WHERE game_id = ?`, [gameId]);
      }

      return this.record(qr, {
        transactionId,
        action: InoutAction.ROLLBACK,
        session,
        userId,
        currency,
        amount,
        debitId,
        gameId,
        gameMode: body.gameMode,
        isFinished,
        applied: refund,
        balanceAfter: after,
        response: { code: InoutCode.OK, balance: formatAmount(after, currency) },
        raw: body,
      });
    });
  }

  // --------------------------------------------------------------- bonus

  /**
   * Bonus spec 6.1 / 6.2 — the provider closes out a FREEBET and tells us the
   * total to credit. `winSum` already includes the stake across every free bet
   * in the grant, so it is credited as-is and never added to anything else.
   *
   * A free bet costs the player nothing, so there is no debit to match against.
   * That makes this the one path where money is created from a webhook alone,
   * which is why the bonusId must resolve to a grant we actually issued.
   */
  private async settleBonus(body: BonusWebhookRequest): Promise<InoutResponse> {
    const { transactionId, bonusId, currency, userId } = body.data;
    const winSum = this.amount(body.data.winSum, currency);

    return this.inTx(async (qr) => {
      const replay = await this.replay(qr, transactionId);
      if (replay) return replay;

      const rows = await qr.query(`SELECT * FROM inout_bonus WHERE bonus_id = ? FOR UPDATE`, [bonusId]);
      const bonus = rows[0];
      if (!bonus) {
        throw new InoutRejection(InoutCode.CHECKS_FAIL, `unknown bonus ${bonusId}`);
      }
      if (bonus.user_id !== userId || bonus.currency !== currency) {
        throw new InoutRejection(InoutCode.CHECKS_FAIL, 'bonus does not belong to this player');
      }
      if (bonus.settled_at) {
        // Different transactionId, same bonus. The settlement primary key would
        // reject the insert anyway; failing here gives a clearer log line.
        throw new InoutRejection(InoutCode.CHECKS_FAIL, `bonus ${bonusId} already settled`);
      }

      // Claim the settlement before crediting; the primary key makes a second
      // settlement for this bonus impossible to commit.
      await qr.query(
        `INSERT INTO inout_bonus_settlement (bonus_id, transaction_id, action) VALUES (?, ?, ?)`,
        [bonusId, transactionId, body.action],
      );

      // The expired-when-active case always arrives as 0 (spec 6.2).
      const after = winSum.isZero()
        ? await this.balanceOf(qr, userId, currency)
        : await this.move(qr, {
            userId,
            currency,
            delta: winSum,
            reference: `inout:bonus:${transactionId}`,
            meta: { bonusId, action: body.action },
          });

      await qr.query(
        `UPDATE inout_bonus SET status = ?, win_sum = ?, settled_at = NOW() WHERE bonus_id = ?`,
        [
          body.action === InoutBonusAction.COMPLETE ? 'COMPLETED' : 'EXPIRED_WHEN_ACTIVE',
          winSum.toFixed(),
          bonusId,
        ],
      );

      const response: InoutResponse = {
        code: InoutCode.OK,
        balance: formatAmount(after, currency),
        ...(bonus.hide_from_stat ? { hideFromStat: true } : {}),
      };

      await qr.query(
        `INSERT INTO inout_transaction
           (transaction_id, action, user_id, game_mode, currency, amount, result,
            bonus_id, balance_after, applied, response, raw_request)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
        [
          transactionId,
          body.action,
          userId,
          body.gameMode ?? null,
          currency,
          winSum.toFixed(),
          bonusId,
          after.toFixed(),
          winSum.isZero() ? 0 : 1,
          JSON.stringify(response),
          JSON.stringify(body),
        ],
      );

      return response;
    });
  }

  /**
   * Record a rollback claim outside the current transaction, so it survives the
   * rollback that follows an error response. Failures here are swallowed: the
   * claim is a safety net, not the answer we owe the provider.
   */
  private async claimRollbackOutOfBand(debitId: string, transactionId: string) {
    try {
      await this.ds.query(
        `INSERT INTO inout_rollback_debit (debit_id, transaction_id) VALUES (?, ?)`,
        [debitId, transactionId],
      );
    } catch (err: any) {
      if (err?.errno !== MYSQL_DUPLICATE_ENTRY) {
        this.log.warn(`could not claim rollback for ${debitId}: ${err?.message}`);
      }
    }
  }

  // ------------------------------------------------------------- helpers

  private amount(raw: string, currency: string): Decimal {
    try {
      return parseAmount(raw, currency);
    } catch (e) {
      if (e instanceof BadAmountError) {
        throw new InoutRejection(InoutCode.CHECKS_FAIL, e.message);
      }
      throw e;
    }
  }

  /** Spec 2.1: a repeated transactionId returns the response from the first run. */
  private async replay(qr: QueryRunner, transactionId: string): Promise<InoutResponse | null> {
    const rows = await qr.query(
      `SELECT response FROM inout_transaction WHERE transaction_id = ? FOR UPDATE`,
      [transactionId],
    );
    if (!rows.length) return null;
    const raw = rows[0].response;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  }

  private async findDebit(qr: QueryRunner, debitId: string) {
    const rows = await qr.query(
      `SELECT * FROM inout_transaction WHERE transaction_id = ? AND action = 'bet'`,
      [debitId],
    );
    return rows[0] ?? null;
  }

  private async requireSession(
    qr: QueryRunner,
    token: string,
    userId: string,
    opts: { enforceExpiry: boolean },
  ): Promise<InoutSession> {
    const session = await this.sessions.resolve(token, qr);
    if (!session) throw new InoutRejection(InoutCode.INVALID_TOKEN, 'session token unknown');
    if (session.user_id !== userId) {
      throw new InoutRejection(InoutCode.CHECKS_FAIL, 'user_id does not match session');
    }
    if (opts.enforceExpiry && new Date(session.expires_at).getTime() < Date.now()) {
      throw new InoutRejection(InoutCode.INVALID_TOKEN, 'session expired');
    }
    return session;
  }

  private async loadPlayer(userId: string, currency: string) {
    const rows = await this.ds.query(
      `SELECT u.id AS user_id, u.nickname, u.avatar_url, u.status AS user_status,
              COALESCE(w.balance, 0) AS balance, COALESCE(w.status, 'active') AS wallet_status
         FROM users u
         LEFT JOIN wallet w ON w.user_id = u.id AND w.currency = ?
        WHERE u.id = ?`,
      [currency, userId],
    );
    const player = rows[0];
    if (!player) throw new InoutRejection(InoutCode.ACCOUNT_INVALID, `no user ${userId}`);
    if (player.user_status !== 'active' || player.wallet_status !== 'active') {
      throw new InoutRejection(InoutCode.ACCOUNT_LOCKED, `user ${userId} is ${player.user_status}`);
    }
    return player;
  }

  private async balanceOf(qr: QueryRunner, userId: string, currency: string): Promise<Decimal> {
    const rows = await qr.query(`SELECT balance FROM wallet WHERE user_id = ? AND currency = ?`, [
      userId,
      currency,
    ]);
    if (!rows.length) throw new InoutRejection(InoutCode.ACCOUNT_INVALID, 'no wallet for currency');
    return new Decimal(rows[0].balance);
  }

  private async lockWallet(qr: QueryRunner, userId: string, currency: string) {
    const rows = await qr.query(
      `SELECT balance, status FROM wallet WHERE user_id = ? AND currency = ? FOR UPDATE`,
      [userId, currency],
    );
    if (!rows.length) throw new InoutRejection(InoutCode.ACCOUNT_INVALID, 'no wallet for currency');
    if (rows[0].status !== 'active') throw new InoutRejection(InoutCode.ACCOUNT_LOCKED, 'wallet locked');
    return { balance: new Decimal(rows[0].balance), status: rows[0].status };
  }

  /**
   * The single place where money moves.
   *
   * MySQL has no UPDATE ... RETURNING, so the new balance is computed here from
   * a locked read rather than read back from the write. Pass `current` if the
   * row is already locked (the bet path does this to check funds first),
   * otherwise this takes the lock itself.
   */
  private async move(
    qr: QueryRunner,
    p: {
      userId: string;
      currency: string;
      delta: Decimal;
      reference: string;
      meta: object;
      current?: Decimal;
    },
  ): Promise<Decimal> {
    const before = p.current ?? (await this.lockWallet(qr, p.userId, p.currency)).balance;
    const after = before.plus(p.delta);
    if (after.isNegative()) {
      throw new InoutRejection(InoutCode.INSUFFICIENT_FUNDS, 'move would overdraw wallet');
    }

    await qr.query(`UPDATE wallet SET balance = ? WHERE user_id = ? AND currency = ?`, [
      after.toFixed(),
      p.userId,
      p.currency,
    ]);

    await qr.query(
      `INSERT INTO wallet_ledger (user_id, currency, delta, balance_after, reference, meta)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [p.userId, p.currency, p.delta.toFixed(), after.toFixed(), p.reference, JSON.stringify(p.meta)],
    );
    return after;
  }

  private async record(
    qr: QueryRunner,
    p: {
      transactionId: string;
      action: InoutAction;
      session: InoutSession | null;
      userId: string;
      currency: string;
      amount: Decimal;
      result?: Decimal;
      coefficient?: Decimal | null;
      debitId?: string;
      gameId?: string;
      gameMode?: string;
      isFinished?: boolean;
      applied: boolean;
      balanceAfter: Decimal;
      response: InoutResponse;
      raw: unknown;
    },
  ): Promise<InoutResponse> {
    await qr.query(
      `INSERT INTO inout_transaction
         (transaction_id, action, session_id, user_id, game_mode, game_id, currency,
          amount, result, coefficient, debit_id, is_finished, balance_after, applied,
          response, raw_request)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        p.transactionId,
        p.action,
        p.session?.id ?? null,
        p.userId,
        p.gameMode ?? null,
        p.gameId ?? null,
        p.currency,
        p.amount.toFixed(),
        p.result?.toFixed() ?? null,
        p.coefficient?.toFixed() ?? null,
        p.debitId ?? null,
        p.isFinished ? 1 : 0,
        p.balanceAfter.toFixed(),
        p.applied ? 1 : 0,
        JSON.stringify(p.response),
        JSON.stringify(p.raw),
      ],
    );
    return p.response;
  }

  /**
   * One DB transaction per webhook, at REPEATABLE READ (InnoDB's default).
   *
   * On a duplicate-key collision the request raced an identical one. We answer
   * TEMPORARY_ERROR rather than guessing: the provider retries, the winner's
   * row is committed by then, and the retry replays its stored response.
   */
  private async inTx(fn: (qr: QueryRunner) => Promise<InoutResponse>): Promise<InoutResponse> {
    const qr = this.ds.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      const out = await fn(qr);
      await qr.commitTransaction();
      return out;
    } catch (err: any) {
      await qr.rollbackTransaction();
      if (err?.errno === MYSQL_DUPLICATE_ENTRY) {
        this.log.warn(`concurrent duplicate webhook: ${err.sqlMessage}`);
        throw new InoutRejection(InoutCode.TEMPORARY_ERROR, 'duplicate in flight');
      }
      throw err;
    } finally {
      await qr.release();
    }
  }
}