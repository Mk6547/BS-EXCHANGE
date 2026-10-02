import { Injectable, Logger } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import Decimal from 'decimal.js';
import { LedgerService } from '../platform/ledger.service';

export class SbError extends Error {}

/**
 * Sic Bo — three dice, RNG, self-settling like the other instant games.
 *
 * A round opens, takes bets for N seconds, then three dice are rolled from a
 * seed committed (hashed) at open, so the result is fixed before any bet and can
 * be rechecked once the seed is published. The house edge lives entirely in the
 * payouts (set in admin); the dice are always fair.
 *
 * Bet types: Small/Big, Odd/Even (all lose to any triple), Any Triple, exact
 * Total 4-17, Single die (pays x1/x2/x3 by how many dice show it), specific
 * Double, specific Triple, and the standard combinations grid.
 */
@Injectable()
export class SicBoService {
  private readonly log = new Logger(SicBoService.name);

  constructor(private readonly ds: DataSource, private readonly ledger: LedgerService) {}

  async config(): Promise<Record<string, string>> {
    const rows = await this.ds.query(`SELECT key_name, value FROM sb_config`);
    const out: Record<string, string> = {};
    for (const r of rows) out[r.key_name] = r.value;
    return out;
  }

  async payouts() {
    return this.ds.query(`SELECT market, selection, label, payout FROM sb_payout ORDER BY sort_order`);
  }

  /** Roll three dice deterministically from the seed. */
  static roll(serverSeed: string, roundNo: number | string) {
    const h = createHash('sha256').update(`${serverSeed}:${roundNo}`).digest('hex');
    const d1 = (parseInt(h.slice(0, 8), 16) % 6) + 1;
    const d2 = (parseInt(h.slice(8, 16), 16) % 6) + 1;
    const d3 = (parseInt(h.slice(16, 24), 16) % 6) + 1;
    return { d1, d2, d3, total: d1 + d2 + d3 };
  }

  /**
   * Decide a single bet against a roll. Returns the profit multiplier to apply
   * to the stake (0 = lost). Single-die multiplies the base rate by the number
   * of dice showing the number.
   */
  static evaluate(market: string, selection: string, baseRate: number, roll: { d1: number; d2: number; d3: number; total: number }): number {
    const dice = [roll.d1, roll.d2, roll.d3];
    const triple = roll.d1 === roll.d2 && roll.d2 === roll.d3;
    const t = roll.total;

    switch (market) {
      case 'smallbig':
        if (triple) return 0; // small/big lose to any triple
        if (selection === 'small') return t >= 4 && t <= 10 ? baseRate : 0;
        if (selection === 'big') return t >= 11 && t <= 17 ? baseRate : 0;
        return 0;
      case 'oddeven':
        if (triple) return 0;
        if (selection === 'odd') return t % 2 === 1 ? baseRate : 0;
        if (selection === 'even') return t % 2 === 0 ? baseRate : 0;
        return 0;
      case 'anytriple':
        return triple ? baseRate : 0;
      case 'total':
        return t === Number(selection) ? baseRate : 0;
      case 'single': {
        const n = dice.filter((d) => d === Number(selection)).length;
        return n > 0 ? baseRate * n : 0; // x1 / x2 / x3 by appearances
      }
      case 'double': {
        const n = dice.filter((d) => d === Number(selection)).length;
        return n >= 2 ? baseRate : 0;
      }
      case 'triple':
        return triple && roll.d1 === Number(selection) ? baseRate : 0;
      case 'combo': {
        const [a, b] = selection.split('-').map(Number);
        return dice.includes(a) && dice.includes(b) ? baseRate : 0;
      }
      default:
        return 0;
    }
  }

  // --------------------------------------------------------- scheduling

  async tick() {
    const cfg = await this.config();
    if (cfg.enabled !== '1') return null;
    const due = await this.ds.query(
      `SELECT id FROM sb_round WHERE status='open' AND closes_at <= NOW() ORDER BY round_no LIMIT 5`);
    for (const r of due) await this.settleRound(r.id).catch((e) => this.log.warn(`settle ${r.id}: ${e.message}`));
    const [live] = await this.ds.query(
      `SELECT * FROM sb_round WHERE status='open' AND closes_at > NOW() ORDER BY round_no DESC LIMIT 1`);
    return live ?? (await this.openRound(Number(cfg.round_seconds ?? 25)));
  }

  private async openRound(seconds: number) {
    const id = randomUUID();
    const seed = randomBytes(32).toString('hex');
    const hash = createHash('sha256').update(seed).digest('hex');
    await this.ds.query(
      `INSERT INTO sb_round (id, server_seed, server_seed_hash, closes_at)
       VALUES (?,?,?, DATE_ADD(NOW(), INTERVAL ? SECOND))`,
      [id, seed, hash, Math.max(10, Math.min(300, seconds))]);
    const [row] = await this.ds.query(`SELECT * FROM sb_round WHERE id=?`, [id]);
    return row;
  }

  async settleRound(roundId: string) {
    const claim = await this.ds.query(`UPDATE sb_round SET status='closed' WHERE id=? AND status='open'`, [roundId]);
    if (!claim.affectedRows) return null;

    const [round] = await this.ds.query(`SELECT * FROM sb_round WHERE id=?`, [roundId]);
    const roll = SicBoService.roll(round.server_seed, round.round_no);
    const bets = await this.ds.query(`SELECT * FROM sb_bet WHERE round_id=? AND status='open'`, [roundId]);
    let paid = new Decimal(0);

    await this.ledger.inTx(async (qr) => {
      for (const bet of bets) {
        const mult = SicBoService.evaluate(bet.market, bet.selection, Number(bet.payout_rate), roll);
        if (mult > 0) {
          const payout = new Decimal(bet.stake).plus(new Decimal(bet.stake).mul(mult));
          await this.ledger.move(qr, {
            userId: bet.user_id, currency: bet.currency, delta: payout,
            reference: `sb:win:${bet.id}`,
            meta: { roundNo: round.round_no, market: bet.market, selection: bet.selection, roll: `${roll.d1}-${roll.d2}-${roll.d3}` },
          });
          await qr.query(`UPDATE sb_bet SET status='settled', result='won', payout=? WHERE id=? AND status='open'`,
            [payout.toFixed(2), bet.id]);
          paid = paid.plus(payout);
        } else {
          await qr.query(`UPDATE sb_bet SET status='settled', result='lost', payout=0 WHERE id=? AND status='open'`, [bet.id]);
        }
      }
      await qr.query(
        `UPDATE sb_round SET status='settled', d1=?, d2=?, d3=?, total=?, settled_at=NOW(), paid=? WHERE id=?`,
        [roll.d1, roll.d2, roll.d3, roll.total, paid.toFixed(2), roundId]);
    });
    return { roundId, roll, bets: bets.length, paid: paid.toFixed(2) };
  }

  // ------------------------------------------------------------ betting

  async placeBet(p: { userId: string; currency: string; market: string; selection: string; stake: string }) {
    const cfg = await this.config();
    if (cfg.enabled !== '1') throw new SbError('The table is closed right now.');

    const [rate] = await this.ds.query(
      `SELECT payout FROM sb_payout WHERE market=? AND selection=?`, [p.market, p.selection]);
    if (!rate) throw new SbError('That selection is not available.');

    if (!/^\d+(\.\d{1,2})?$/.test(String(p.stake))) throw new SbError('Enter a valid amount.');
    const stake = new Decimal(p.stake);
    const min = new Decimal(cfg.min_stake ?? 100);
    const max = new Decimal(cfg.max_stake ?? 50000);
    if (stake.lt(min)) throw new SbError(`Minimum is ${min.toFixed(0)}.`);
    if (stake.gt(max)) throw new SbError(`Maximum is ${max.toFixed(0)}.`);

    const round = await this.tick();
    if (!round) throw new SbError('No round is running.');

    // Per-selection exposure cap: limit the house's potential payout on one
    // selection in a round. 0 = no cap. Single die can pay x3, so size at x3.
    const cap = new Decimal(cfg.max_exposure_per_selection ?? 0);
    if (cap.gt(0)) {
      const worst = p.market === 'single' ? new Decimal(rate.payout).mul(3) : new Decimal(rate.payout);
      const [ex] = await this.ds.query(
        `SELECT COALESCE(SUM(stake * (1 + payout_rate * ?)),0) AS exposure
           FROM sb_bet WHERE round_id=? AND market=? AND selection=? AND status='open'`,
        [p.market === 'single' ? 3 : 1, round.id, p.market, p.selection]);
      const wouldBe = new Decimal(ex?.exposure ?? 0).plus(stake.mul(worst.plus(1)));
      if (wouldBe.gt(cap)) throw new SbError('This selection is full for this round. Try another or wait for the next round.');
    }

    const id = randomUUID();
    const reference = LedgerService.reference('SB');
    await this.ledger.inTx(async (qr: QueryRunner) => {
      const [fresh] = await qr.query(`SELECT status, closes_at > NOW() AS live FROM sb_round WHERE id=? FOR UPDATE`, [round.id]);
      if (!fresh || fresh.status !== 'open' || !Number(fresh.live)) throw new SbError('No more bets on this round. Wait for the next roll.');
      await this.ledger.move(qr, {
        userId: p.userId, currency: p.currency, delta: stake.negated(),
        reference: `sb:bet:${id}`, meta: { roundNo: round.round_no, market: p.market, selection: p.selection },
      });
      await qr.query(
        `INSERT INTO sb_bet (id, reference, round_id, user_id, currency, market, selection, payout_rate, stake)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [id, reference, round.id, p.userId, p.currency, p.market, p.selection, new Decimal(rate.payout).toFixed(3), stake.toFixed(2)]);
      await qr.query(`UPDATE sb_round SET staked = staked + ? WHERE id=?`, [stake.toFixed(2), round.id]);
    });
    return {
      id, reference, roundNo: round.round_no, market: p.market, selection: p.selection,
      rate: new Decimal(rate.payout).toFixed(2), stake: stake.toFixed(2),
    };
  }

  async state(userId?: string) {
    const cfg = await this.config();
    const payouts = await this.payouts();
    const round = await this.tick();
    const myBets = userId && round
      ? await this.ds.query(
          `SELECT market, selection, payout_rate, SUM(stake) AS stake
             FROM sb_bet WHERE round_id=? AND user_id=? GROUP BY market, selection, payout_rate`,
          [round.id, userId])
      : [];
    const history = await this.ds.query(
      `SELECT round_no, d1, d2, d3, total, server_seed, server_seed_hash, settled_at
         FROM sb_round WHERE status='settled' ORDER BY round_no DESC LIMIT 20`);
    const last = history[0];
    return {
      enabled: cfg.enabled === '1',
      minStake: Number(cfg.min_stake ?? 100).toFixed(0),
      maxStake: Number(cfg.max_stake ?? 50000).toFixed(0),
      roundSeconds: Number(cfg.round_seconds ?? 25),
      payouts: payouts.map((p: any) => ({ market: p.market, selection: p.selection, label: p.label, rate: Number(p.payout).toFixed(2) })),
      round: round ? {
        no: round.round_no, hash: round.server_seed_hash,
        secondsLeft: Math.max(0, Math.round((new Date(round.closes_at).getTime() - Date.now()) / 1000)),
        staked: Number(round.staked ?? 0).toFixed(2),
      } : null,
      myBets: myBets.map((b: any) => ({ market: b.market, selection: b.selection, stake: Number(b.stake).toFixed(2) })),
      lastResult: last ? {
        roundNo: last.round_no, d1: last.d1, d2: last.d2, d3: last.d3, total: last.total, seed: last.server_seed,
      } : null,
      history: history.map((h: any) => ({ roundNo: h.round_no, d1: h.d1, d2: h.d2, d3: h.d3, total: h.total })),
    };
  }

  async myRecentBets(userId: string, limit = 30) {
    const rows = await this.ds.query(
      `SELECT b.reference, b.market, b.selection, b.payout_rate, b.stake, b.payout, b.result, b.status, b.placed_at, r.round_no, r.total
         FROM sb_bet b JOIN sb_round r ON r.id = b.round_id
        WHERE b.user_id=? ORDER BY b.placed_at DESC LIMIT ?`,
      [userId, Math.min(Math.max(limit, 1), 100)]);
    return rows.map((b: any) => ({
      reference: b.reference, roundNo: b.round_no, market: b.market, selection: b.selection,
      rate: Number(b.payout_rate).toFixed(2), stake: Number(b.stake).toFixed(2),
      payout: b.payout === null ? null : Number(b.payout).toFixed(2), result: b.result, status: b.status, placedAt: b.placed_at,
    }));
  }
}
