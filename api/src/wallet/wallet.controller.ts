import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

/**
 * Read-only wallet views for the player's own account.
 *
 * Every query is scoped by req.user.id from the verified token — never by an id
 * in the query string — so one player cannot read another's history.
 */
@Controller('wallet')
@UseGuards(JwtAuthGuard)
export class WalletController {
  constructor(private readonly ds: DataSource) {}

  @Get('summary')
  async summary(@Req() req: any) {
    const [wallet] = await this.ds.query(
      `SELECT w.balance, w.currency, w.status
         FROM wallet w JOIN users u ON u.id = w.user_id AND u.currency = w.currency
        WHERE w.user_id = ?`,
      [req.user.id],
    );
    const [totals] = await this.ds.query(
      `SELECT
         COUNT(*)                                        AS rounds,
         COALESCE(SUM(CASE WHEN action = 'bet' AND applied = 1 THEN amount END), 0)    AS staked,
         COALESCE(SUM(CASE WHEN action = 'withdraw' AND applied = 1 THEN result END), 0) AS won
       FROM inout_transaction WHERE user_id = ? AND action IN ('bet','withdraw')`,
      [req.user.id],
    );

    return {
      balance: Number(wallet?.balance ?? 0).toFixed(2),
      currency: wallet?.currency ?? 'PKR',
      status: wallet?.status ?? 'active',
      rounds: Number(totals?.rounds ?? 0),
      staked: Number(totals?.staked ?? 0).toFixed(2),
      won: Number(totals?.won ?? 0).toFixed(2),
    };
  }

  /** Ledger entries, newest first. The ledger is the authoritative money record. */
  @Get('history')
  async history(@Req() req: any, @Query() q: { page?: string; limit?: string }) {
    const limit = Math.min(Math.max(Number(q.limit ?? 25), 1), 100);
    const page = Math.max(Number(q.page ?? 1), 1);
    const offset = (page - 1) * limit;

    const rows = await this.ds.query(
      `SELECT id, delta, balance_after, reference, currency, created_at
         FROM wallet_ledger
        WHERE user_id = ?
        ORDER BY id DESC
        LIMIT ? OFFSET ?`,
      [req.user.id, limit, offset],
    );
    const [count] = await this.ds.query(
      `SELECT COUNT(*) AS n FROM wallet_ledger WHERE user_id = ?`,
      [req.user.id],
    );

    return {
      page,
      limit,
      total: Number(count.n),
      entries: rows.map((r: any) => ({
        id: r.id,
        // 'inout:bet:<uuid>' -> 'bet'. The reference is built in the webhook
        // service; splitting it here keeps the ledger format in one place.
        kind: String(r.reference).split(':')[1] ?? 'adjustment',
        amount: Number(r.delta).toFixed(2),
        balanceAfter: Number(r.balance_after).toFixed(2),
        currency: r.currency,
        at: r.created_at,
      })),
    };
  }

  /** Recent rounds, for the game history tab. */
  @Get('rounds')
  async rounds(@Req() req: any, @Query() q: { limit?: string }) {
    const limit = Math.min(Math.max(Number(q.limit ?? 25), 1), 100);
    const rows = await this.ds.query(
      `SELECT game_mode, action, amount, result, coefficient, balance_after, created_at
         FROM inout_transaction
        WHERE user_id = ? AND action IN ('bet','withdraw')
        ORDER BY id DESC LIMIT ?`,
      [req.user.id, limit],
    );
    return {
      rounds: rows.map((r: any) => ({
        gameMode: r.game_mode,
        action: r.action,
        amount: Number(r.amount).toFixed(2),
        result: r.result === null ? null : Number(r.result).toFixed(2),
        coefficient: r.coefficient === null ? null : Number(r.coefficient).toFixed(2),
        balanceAfter: Number(r.balance_after).toFixed(2),
        at: r.created_at,
      })),
    };
  }
}
