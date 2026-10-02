import { Injectable } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import { randomUUID } from 'node:crypto';
import Decimal from 'decimal.js';

/**
 * The one place outside the InOut webhook handler where balances change.
 *
 * Everything here locks the wallet row first and writes a wallet_ledger entry
 * in the same transaction, so the ledger stays the authoritative record of the
 * balance no matter which part of the system moved the money.
 */
@Injectable()
export class LedgerService {
  constructor(private readonly ds: DataSource) {}

  /** Short human reference for deposits and withdrawals, e.g. DP-7F3K2Q. */
  static reference(prefix: string): string {
    const body = randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();
    return `${prefix}-${body}`;
  }

  async balanceOf(userId: string, currency: string): Promise<Decimal> {
    const [row] = await this.ds.query(
      `SELECT balance FROM wallet WHERE user_id = ? AND currency = ?`,
      [userId, currency],
    );
    return new Decimal(row?.balance ?? 0);
  }

  /**
   * Apply a signed change inside an existing transaction.
   * `reference` must be unique — the ledger has a unique index on it, which is
   * what stops an approval being applied twice if a request is retried.
   */
  async move(
    qr: QueryRunner,
    p: { userId: string; currency: string; delta: Decimal; reference: string; meta?: object },
  ): Promise<{ before: Decimal; after: Decimal }> {
    const [row] = await qr.query(
      `SELECT balance, status FROM wallet WHERE user_id = ? AND currency = ? FOR UPDATE`,
      [p.userId, p.currency],
    );
    if (!row) throw new Error('No wallet for that player and currency.');
    if (row.status !== 'active') throw new Error('That wallet is not active.');

    const before = new Decimal(row.balance);
    const after = before.plus(p.delta);
    if (after.isNegative()) throw new Error('That would take the balance below zero.');

    await qr.query(`UPDATE wallet SET balance = ? WHERE user_id = ? AND currency = ?`, [
      after.toFixed(),
      p.userId,
      p.currency,
    ]);
    await qr.query(
      `INSERT INTO wallet_ledger (user_id, currency, delta, balance_after, reference, meta)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [p.userId, p.currency, p.delta.toFixed(), after.toFixed(), p.reference, JSON.stringify(p.meta ?? {})],
    );
    return { before, after };
  }

  /** Run work in a transaction, releasing the connection either way. */
  async inTx<T>(fn: (qr: QueryRunner) => Promise<T>): Promise<T> {
    const qr = this.ds.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      const out = await fn(qr);
      await qr.commitTransaction();
      return out;
    } catch (err) {
      await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
  }
}
