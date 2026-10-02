import { Injectable, Logger } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import Decimal from 'decimal.js';
import { LedgerService } from '../platform/ledger.service';

export class AbError extends Error {}

const SUITS = ['S', 'H', 'D', 'C'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];

/**
 * Andar Bahar — instant game, self-settling like the wheel.
 *
 * A joker card is drawn from a shuffled deck; cards are then dealt alternately
 * to Bahar and Andar (Bahar first is one common convention) until a card of the
 * joker's rank appears. That side wins. Players bet the side, plus side markets:
 * how many cards it took, and the joker's suit.
 *
 * Fairness works exactly like the other games: the deck is shuffled from a
 * secret committed (hashed) when the round opens, so the whole deal is fixed
 * before any bet and can be rechecked once the seed is published. The house
 * edge lives entirely in the payouts, set in admin — nothing weights the deck.
 */
@Injectable()
export class AndarBaharService {
  private readonly log = new Logger(AndarBaharService.name);

  constructor(
    private readonly ds: DataSource,
    private readonly ledger: LedgerService,
  ) {}

  async config(): Promise<Record<string, string>> {
    const rows = await this.ds.query(`SELECT key_name, value FROM ab_config`);
    const out: Record<string, string> = {};
    for (const r of rows) out[r.key_name] = r.value;
    return out;
  }

  async payouts() {
    return this.ds.query(`SELECT market, selection, label, payout FROM ab_payout ORDER BY sort_order`);
  }

  // ------------------------------------------------------------ the deal

  /** Deterministic shuffle from the seed, then deal out the round. */
  static play(serverSeed: string, roundNo: number | string) {
    const deck: string[] = [];
    for (const r of RANKS) for (const s of SUITS) deck.push(r + s);

    let stream = createHash('sha256').update(`${serverSeed}:${roundNo}`).digest('hex');
    let cursor = 0;
    const next = () => {
      if (cursor + 8 > stream.length) { stream = createHash('sha256').update(stream).digest('hex'); cursor = 0; }
      const v = parseInt(stream.slice(cursor, cursor + 8), 16);
      cursor += 8;
      return v;
    };
    for (let i = deck.length - 1; i > 0; i--) {
      const j = next() % (i + 1);
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }

    const joker = deck[0];
    const jokerRank = joker[0];
    const andar: string[] = [];
    const bahar: string[] = [];
    let winning: 'andar' | 'bahar' = 'bahar';
    let i = 1;
    let dealt = 0;
    // Bahar receives first, then alternate.
    let toBahar = true;
    while (i < deck.length) {
      const card = deck[i++];
      dealt++;
      if (toBahar) { bahar.push(card); if (card[0] === jokerRank) { winning = 'bahar'; break; } }
      else { andar.push(card); if (card[0] === jokerRank) { winning = 'andar'; break; } }
      toBahar = !toBahar;
    }
    return { joker, winning, cardsDealt: dealt, andar, bahar };
  }

  static countBucket(n: number): string {
    if (n <= 5) return '1-5';
    if (n <= 10) return '6-10';
    if (n <= 15) return '11-15';
    return '16+';
  }

  // -------------------------------------------------------- scheduling

  async tick() {
    const cfg = await this.config();
    if (cfg.enabled !== '1') return null;
    const due = await this.ds.query(
      `SELECT id FROM ab_round WHERE status='open' AND closes_at <= NOW() ORDER BY round_no LIMIT 5`);
    for (const r of due) await this.settleRound(r.id).catch((e) => this.log.warn(`settle ${r.id}: ${e.message}`));
    const [live] = await this.ds.query(
      `SELECT * FROM ab_round WHERE status='open' AND closes_at > NOW() ORDER BY round_no DESC LIMIT 1`);
    return live ?? (await this.openRound(Number(cfg.round_seconds ?? 25)));
  }

  private async openRound(seconds: number) {
    const id = randomUUID();
    const serverSeed = randomBytes(32).toString('hex');
    const hash = createHash('sha256').update(serverSeed).digest('hex');
    await this.ds.query(
      `INSERT INTO ab_round (id, server_seed, server_seed_hash, closes_at)
       VALUES (?,?,?, DATE_ADD(NOW(), INTERVAL ? SECOND))`,
      [id, serverSeed, hash, Math.max(10, Math.min(300, seconds))]);
    const [row] = await this.ds.query(`SELECT * FROM ab_round WHERE id = ?`, [id]);
    return row;
  }

  async settleRound(roundId: string) {
    const claim = await this.ds.query(`UPDATE ab_round SET status='closed' WHERE id=? AND status='open'`, [roundId]);
    if (!claim.affectedRows) return null;

    const [round] = await this.ds.query(`SELECT * FROM ab_round WHERE id=?`, [roundId]);
    const res = AndarBaharService.play(round.server_seed, round.round_no);
    const countBucket = AndarBaharService.countBucket(res.cardsDealt);
    const suit = res.joker[1];

    const payouts = await this.payouts();
    const rateOf = (market: string, selection: string) => {
      const r = payouts.find((p: any) => p.market === market && p.selection === selection);
      return r ? new Decimal(r.payout) : null;
    };

    const bets = await this.ds.query(`SELECT * FROM ab_bet WHERE round_id=? AND status='open'`, [roundId]);
    let paid = new Decimal(0);

    await this.ledger.inTx(async (qr) => {
      for (const bet of bets) {
        let won = false;
        if (bet.market === 'side') won = bet.selection === res.winning;
        else if (bet.market === 'count') won = bet.selection === countBucket;
        else if (bet.market === 'suit') won = bet.selection === suit;

        if (won) {
          // return stake + profit at the rate snapshotted when the bet was placed
          const payout = new Decimal(bet.stake).plus(new Decimal(bet.stake).mul(bet.payout_rate));
          await this.ledger.move(qr, {
            userId: bet.user_id, currency: bet.currency, delta: payout,
            reference: `ab:win:${bet.id}`,
            meta: { roundNo: round.round_no, market: bet.market, selection: bet.selection },
          });
          await qr.query(`UPDATE ab_bet SET status='settled', result='won', payout=? WHERE id=? AND status='open'`,
            [payout.toFixed(2), bet.id]);
          paid = paid.plus(payout);
        } else {
          await qr.query(`UPDATE ab_bet SET status='settled', result='lost', payout=0 WHERE id=? AND status='open'`, [bet.id]);
        }
      }
      await qr.query(
        `UPDATE ab_round SET status='settled', joker=?, winning_side=?, cards_dealt=?, andar_cards=?, bahar_cards=?, settled_at=NOW(), paid=?
          WHERE id=?`,
        [res.joker, res.winning, res.cardsDealt, res.andar.join(','), res.bahar.join(','), paid.toFixed(2), roundId]);
    });

    return { roundId, winning: res.winning, joker: res.joker, cardsDealt: res.cardsDealt, paid: paid.toFixed(2) };
  }

  // ------------------------------------------------------------ betting

  async placeBet(p: { userId: string; currency: string; market: string; selection: string; stake: string }) {
    const cfg = await this.config();
    if (cfg.enabled !== '1') throw new AbError('The table is closed right now.');
    if (!['side', 'count', 'suit'].includes(p.market)) throw new AbError('Unknown bet.');
    if (p.market === 'side' && cfg.side_enabled !== '1') throw new AbError('That market is closed.');
    if (p.market === 'count' && cfg.count_enabled !== '1') throw new AbError('That market is closed.');
    if (p.market === 'suit' && cfg.suit_enabled !== '1') throw new AbError('That market is closed.');

    if (!/^\d+(\.\d{1,2})?$/.test(String(p.stake))) throw new AbError('Enter a valid amount.');
    const stake = new Decimal(p.stake);
    const min = new Decimal(cfg.min_stake ?? 100);
    const max = new Decimal(cfg.max_stake ?? 50000);
    if (stake.lt(min)) throw new AbError(`Minimum is ${min.toFixed(0)}.`);
    if (stake.gt(max)) throw new AbError(`Maximum is ${max.toFixed(0)}.`);

    const [rate] = await this.ds.query(
      `SELECT payout FROM ab_payout WHERE market=? AND selection=?`, [p.market, p.selection]);
    if (!rate) throw new AbError('That selection is not available.');

    const round = await this.tick();
    if (!round) throw new AbError('No round is running.');

    // Per-side exposure cap: limits how much the house can be liable for on any
    // one selection in a round, so a run of money on one side can't create a
    // payout bigger than the house wants to carry. 0 = no cap.
    const cap = new Decimal(cfg.max_exposure_per_side ?? 0);
    if (cap.gt(0)) {
      const [ex] = await this.ds.query(
        `SELECT COALESCE(SUM(stake * (1 + payout_rate)),0) AS exposure
           FROM ab_bet WHERE round_id = ? AND market = ? AND selection = ? AND status = 'open'`,
        [round.id, p.market, p.selection]);
      const wouldBe = new Decimal(ex?.exposure ?? 0).plus(stake.mul(new Decimal(rate.payout).plus(1)));
      if (wouldBe.gt(cap)) {
        throw new AbError('This selection is full for this round. Try another or wait for the next round.');
      }
    }

    const id = randomUUID();
    const reference = LedgerService.reference('AB');

    await this.ledger.inTx(async (qr: QueryRunner) => {
      const [fresh] = await qr.query(
        `SELECT status, closes_at > NOW() AS live FROM ab_round WHERE id=? FOR UPDATE`, [round.id]);
      if (!fresh || fresh.status !== 'open' || !Number(fresh.live)) {
        throw new AbError('No more bets on this round. Wait for the next deal.');
      }
      await this.ledger.move(qr, {
        userId: p.userId, currency: p.currency, delta: stake.negated(),
        reference: `ab:bet:${id}`, meta: { roundNo: round.round_no, market: p.market, selection: p.selection },
      });
      await qr.query(
        `INSERT INTO ab_bet (id, reference, round_id, user_id, currency, market, selection, payout_rate, stake)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [id, reference, round.id, p.userId, p.currency, p.market, p.selection, new Decimal(rate.payout).toFixed(3), stake.toFixed(2)]);
      await qr.query(`UPDATE ab_round SET staked = staked + ? WHERE id=?`, [stake.toFixed(2), round.id]);
    });

    return {
      id, reference, roundNo: round.round_no, market: p.market, selection: p.selection,
      rate: new Decimal(rate.payout).toFixed(2), stake: stake.toFixed(2),
      toWin: stake.plus(stake.mul(rate.payout)).toFixed(2),
    };
  }

  async state(userId?: string) {
    const cfg = await this.config();
    const payouts = await this.payouts();
    const round = await this.tick();

    const myBets = userId && round
      ? await this.ds.query(
          `SELECT market, selection, payout_rate, SUM(stake) AS stake
             FROM ab_bet WHERE round_id=? AND user_id=? GROUP BY market, selection, payout_rate`,
          [round.id, userId])
      : [];

    const history = await this.ds.query(
      `SELECT round_no, joker, winning_side, cards_dealt, server_seed, server_seed_hash, settled_at
         FROM ab_round WHERE status='settled' ORDER BY round_no DESC LIMIT 20`);
    const last = history[0];

    return {
      enabled: cfg.enabled === '1',
      markets: {
        side: cfg.side_enabled === '1', count: cfg.count_enabled === '1', suit: cfg.suit_enabled === '1',
      },
      minStake: Number(cfg.min_stake ?? 100).toFixed(0),
      maxStake: Number(cfg.max_stake ?? 50000).toFixed(0),
      roundSeconds: Number(cfg.round_seconds ?? 25),
      payouts: payouts.map((p: any) => ({ market: p.market, selection: p.selection, label: p.label, rate: Number(p.payout).toFixed(2) })),
      round: round ? {
        no: round.round_no, hash: round.server_seed_hash,
        secondsLeft: Math.max(0, Math.round((new Date(round.closes_at).getTime() - Date.now()) / 1000)),
        staked: Number(round.staked ?? 0).toFixed(2),
      } : null,
      myBets: myBets.map((b: any) => ({
        market: b.market, selection: b.selection,
        stake: Number(b.stake).toFixed(2),
        toWin: (Number(b.stake) + Number(b.stake) * Number(b.payout_rate)).toFixed(2),
      })),
      lastResult: last ? {
        roundNo: last.round_no, joker: last.joker, winning: last.winning_side,
        cardsDealt: last.cards_dealt, seed: last.server_seed,
      } : null,
      history: history.map((h: any) => ({ roundNo: h.round_no, winning: h.winning_side, joker: h.joker })),
    };
  }

  async myRecentBets(userId: string, limit = 30) {
    const rows = await this.ds.query(
      `SELECT b.reference, b.market, b.selection, b.payout_rate, b.stake, b.payout, b.result, b.status, b.placed_at, r.round_no, r.winning_side
         FROM ab_bet b JOIN ab_round r ON r.id = b.round_id
        WHERE b.user_id=? ORDER BY b.placed_at DESC LIMIT ?`,
      [userId, Math.min(Math.max(limit, 1), 100)]);
    return rows.map((b: any) => ({
      reference: b.reference, roundNo: b.round_no, market: b.market, selection: b.selection,
      rate: Number(b.payout_rate).toFixed(2), stake: Number(b.stake).toFixed(2),
      payout: b.payout === null ? null : Number(b.payout).toFixed(2), result: b.result, status: b.status, placedAt: b.placed_at,
    }));
  }
}
