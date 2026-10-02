import { BadRequestException, Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import Decimal from 'decimal.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { LedgerService } from './ledger.service';
import { parseJson, shape } from './content.controller';

/**
 * Player-facing deposits and withdrawals.
 *
 * Deposits credit nothing until an admin approves them — the player is simply
 * declaring that they sent money. Withdrawals debit immediately on request, so
 * the amount cannot be gambled while the payout is pending; a rejection puts it
 * straight back.
 */
@Controller('payments')
@UseGuards(JwtAuthGuard)
export class PaymentsController {
  constructor(
    private readonly ds: DataSource,
    private readonly ledger: LedgerService,
  ) {}

  @Get('methods')
  async methods() {
    const rows = await this.ds.query(
      `SELECT * FROM payment_method WHERE enabled = 1 ORDER BY sort_order, display_name`,
    );
    return { methods: rows.map(shape) };
  }

  @Post('deposits')
  async createDeposit(
    @Req() req: any,
    @Body() body: { methodId: string; amount: string; note?: string; proofUrl?: string },
  ) {
    const [method] = await this.ds.query(
      `SELECT * FROM payment_method WHERE id = ? AND enabled = 1 AND supports_deposit = 1`,
      [body?.methodId],
    );
    if (!method) throw new BadRequestException({ message: 'That payment method is not available.' });

    const amount = money(body?.amount, 'Enter a valid amount.');
    const min = new Decimal(method.min_deposit ?? 0);
    const max = method.max_deposit === null ? null : new Decimal(method.max_deposit);
    if (amount.lt(min)) throw new BadRequestException({ message: `Minimum deposit is ${min.toFixed(2)}.` });
    if (max && amount.gt(max)) throw new BadRequestException({ message: `Maximum deposit is ${max.toFixed(2)}.` });

    const id = randomUUID();
    const reference = LedgerService.reference('DP');
    await this.ds.query(
      `INSERT INTO deposit (id, reference, user_id, method_id, currency, amount, player_note, proof_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, reference, req.user.id, method.id, method.currency, amount.toFixed(2),
       body?.note?.slice(0, 255) ?? null, body?.proofUrl?.slice(0, 512) ?? null],
    );

    return {
      id,
      reference,
      status: 'pending',
      amount: amount.toFixed(2),
      currency: method.currency,
      // Only revealed once a deposit exists, so the account details are not
      // sitting on a public endpoint for anyone to scrape.
      payTo: method.pay_to_details,
      instructions: method.instructions,
    };
  }

  @Get('deposits')
  async myDeposits(@Req() req: any, @Query() q: { limit?: string }) {
    const limit = Math.min(Math.max(Number(q.limit ?? 25), 1), 100);
    const rows = await this.ds.query(
      `SELECT d.reference, d.amount, d.credited, d.currency, d.status, d.admin_note, d.created_at,
              m.display_name AS method
         FROM deposit d JOIN payment_method m ON m.id = d.method_id
        WHERE d.user_id = ? ORDER BY d.created_at DESC LIMIT ?`,
      [req.user.id, limit],
    );
    return { deposits: rows };
  }

  @Post('withdrawals')
  async createWithdrawal(
    @Req() req: any,
    @Body() body: { methodId: string; amount: string; details?: Record<string, string> },
  ) {
    const [method] = await this.ds.query(
      `SELECT * FROM payment_method WHERE id = ? AND enabled = 1 AND supports_withdrawal = 1`,
      [body?.methodId],
    );
    if (!method) throw new BadRequestException({ message: 'That withdrawal method is not available.' });

    const amount = money(body?.amount, 'Enter a valid amount.');
    const min = new Decimal(method.min_withdrawal ?? 0);
    const max = method.max_withdrawal === null ? null : new Decimal(method.max_withdrawal);
    if (amount.lt(min)) throw new BadRequestException({ message: `Minimum withdrawal is ${min.toFixed(2)}.` });
    if (max && amount.gt(max)) throw new BadRequestException({ message: `Maximum withdrawal is ${max.toFixed(2)}.` });

    const required: string[] = parseJson(method.required_fields) ?? [];
    const details = body?.details ?? {};
    const missing = required.filter((f) => !String(details[f] ?? '').trim());
    if (missing.length) {
      throw new BadRequestException({ message: `Please fill in: ${missing.join(', ')}.` });
    }

    const fee = amount.times(new Decimal(method.withdrawal_fee_pct ?? 0)).dividedBy(100);
    const payable = amount.minus(fee);
    const id = randomUUID();
    const reference = LedgerService.reference('WD');

    try {
      await this.ledger.inTx(async (qr) => {
        // Debit on request. Holding the money aside is what stops a player
        // withdrawing and gambling the same balance before payout.
        await this.ledger.move(qr, {
          userId: req.user.id,
          currency: method.currency,
          delta: amount.neg(),
          reference: `wd:${reference}`,
          meta: { methodId: method.id },
        });
        await qr.query(
          `INSERT INTO withdrawal (id, reference, user_id, method_id, currency, amount, fee, payable, details)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, reference, req.user.id, method.id, method.currency,
           amount.toFixed(2), fee.toFixed(2), payable.toFixed(2), JSON.stringify(details)],
        );
      });
    } catch (err: any) {
      throw new BadRequestException({ message: err?.message ?? 'Withdrawal could not be created.' });
    }

    return { id, reference, status: 'pending', amount: amount.toFixed(2), fee: fee.toFixed(2), payable: payable.toFixed(2) };
  }

  @Get('withdrawals')
  async myWithdrawals(@Req() req: any, @Query() q: { limit?: string }) {
    const limit = Math.min(Math.max(Number(q.limit ?? 25), 1), 100);
    const rows = await this.ds.query(
      `SELECT w.reference, w.amount, w.fee, w.payable, w.currency, w.status, w.admin_note, w.created_at,
              m.display_name AS method
         FROM withdrawal w JOIN payment_method m ON m.id = w.method_id
        WHERE w.user_id = ? ORDER BY w.created_at DESC LIMIT ?`,
      [req.user.id, limit],
    );
    return { withdrawals: rows };
  }
}

function money(raw: unknown, message: string): Decimal {
  const s = String(raw ?? '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new BadRequestException({ message });
  const d = new Decimal(s);
  if (d.lte(0)) throw new BadRequestException({ message });
  return d;
}
