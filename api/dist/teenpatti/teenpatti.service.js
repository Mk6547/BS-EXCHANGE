"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
var TeenPattiService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.TeenPattiService = exports.TpError = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("typeorm");
const node_crypto_1 = require("node:crypto");
const decimal_js_1 = __importDefault(require("decimal.js"));
const ledger_service_1 = require("../platform/ledger.service");
const max_bet_util_1 = require("../agents/max-bet.util");
class TpError extends Error {
}
exports.TpError = TpError;
const SUITS = ['S', 'H', 'D', 'C'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
/**
 * Teen Patti 20-20, dealt by the house.
 *
 * The dealer gives three cards to Player A and three to Player B. Nobody holds
 * cards: players back or lay either hand on match odds, and can back Pair Plus,
 * which pays on hand strength whether or not that hand wins.
 *
 * Rounds run on the clock exactly like the wheel — every request calls tick(),
 * which settles anything expired and opens the next round. The deck is shuffled
 * from a secret seed committed at round open, so the cards are fixed before a
 * single bet is placed and can be rechecked afterwards.
 */
let TeenPattiService = TeenPattiService_1 = class TeenPattiService {
    ds;
    ledger;
    log = new common_1.Logger(TeenPattiService_1.name);
    constructor(ds, ledger) {
        this.ds = ds;
        this.ledger = ledger;
    }
    async config() {
        const rows = await this.ds.query(`SELECT key_name, value FROM tp_config`);
        const out = {};
        for (const r of rows)
            out[r.key_name] = r.value;
        return out;
    }
    async payouts() {
        return this.ds.query(`SELECT hand_rank, label, payout FROM tp_payout ORDER BY sort_order`);
    }
    // ------------------------------------------------------------ cards
    /** Fisher-Yates driven by the seed, so the same seed always deals the same cards. */
    static deal(serverSeed, roundNo) {
        const deck = [];
        for (const r of RANKS)
            for (const s of SUITS)
                deck.push(r + s);
        let stream = (0, node_crypto_1.createHash)('sha256').update(`${serverSeed}:${roundNo}`).digest('hex');
        let cursor = 0;
        const next = () => {
            if (cursor + 8 > stream.length) {
                stream = (0, node_crypto_1.createHash)('sha256').update(stream).digest('hex');
                cursor = 0;
            }
            const chunk = stream.slice(cursor, cursor + 8);
            cursor += 8;
            return parseInt(chunk, 16);
        };
        for (let i = deck.length - 1; i > 0; i--) {
            const j = next() % (i + 1);
            [deck[i], deck[j]] = [deck[j], deck[i]];
        }
        // Dealt one at a time, alternating, the way a dealer would.
        return {
            handA: [deck[0], deck[2], deck[4]],
            handB: [deck[1], deck[3], deck[5]],
        };
    }
    /** Teen Patti order: trail, straight flush, straight, flush, pair, high card. */
    static rankHand(cards) {
        const values = cards.map((c) => RANKS.indexOf(c[0]) + 2).sort((a, b) => b - a);
        const suits = cards.map((c) => c[1]);
        const flush = suits.every((s) => s === suits[0]);
        // A-2-3 is the lowest straight in Teen Patti, and A-K-Q the highest.
        const sorted = [...values].sort((a, b) => a - b);
        const normal = sorted[2] - sorted[1] === 1 && sorted[1] - sorted[0] === 1;
        const wheel = sorted[0] === 2 && sorted[1] === 3 && sorted[2] === 14;
        const straight = normal || wheel;
        const straightHigh = wheel ? [3, 2, 14] : values;
        const counts = {};
        for (const v of values)
            counts[v] = (counts[v] ?? 0) + 1;
        const trail = Object.values(counts).some((n) => n === 3);
        const pairValue = Number(Object.keys(counts).find((k) => counts[Number(k)] === 2) ?? 0);
        if (trail)
            return { rank: 'trail', score: [6, values[0]] };
        if (straight && flush)
            return { rank: 'straightflush', score: [5, ...straightHigh] };
        if (straight)
            return { rank: 'straight', score: [4, ...straightHigh] };
        if (flush)
            return { rank: 'flush', score: [3, ...values] };
        if (pairValue) {
            const kicker = values.find((v) => v !== pairValue) ?? 0;
            return { rank: 'pair', score: [2, pairValue, kicker] };
        }
        return { rank: 'highcard', score: [1, ...values] };
    }
    static compare(a, b) {
        const ra = TeenPattiService_1.rankHand(a).score;
        const rb = TeenPattiService_1.rankHand(b).score;
        for (let i = 0; i < Math.max(ra.length, rb.length); i++) {
            const x = ra[i] ?? 0;
            const y = rb[i] ?? 0;
            if (x !== y)
                return x > y ? 'A' : 'B';
        }
        return 'tie';
    }
    // -------------------------------------------------------- scheduling
    async tick() {
        const cfg = await this.config();
        if (cfg.enabled !== '1')
            return null;
        const due = await this.ds.query(`SELECT id FROM tp_round WHERE status = 'open' AND closes_at <= NOW() ORDER BY round_no LIMIT 5`);
        for (const r of due)
            await this.settleRound(r.id).catch((e) => this.log.warn(`settle ${r.id}: ${e.message}`));
        const [live] = await this.ds.query(`SELECT * FROM tp_round WHERE status = 'open' AND closes_at > NOW() ORDER BY round_no DESC LIMIT 1`);
        return live ?? (await this.openRound(Number(cfg.round_seconds ?? 30)));
    }
    async openRound(seconds) {
        const id = (0, node_crypto_1.randomUUID)();
        const serverSeed = (0, node_crypto_1.randomBytes)(32).toString('hex');
        const hash = (0, node_crypto_1.createHash)('sha256').update(serverSeed).digest('hex');
        await this.ds.query(`INSERT INTO tp_round (id, server_seed, server_seed_hash, closes_at)
       VALUES (?,?,?, DATE_ADD(NOW(), INTERVAL ? SECOND))`, [id, serverSeed, hash, Math.max(10, Math.min(300, seconds))]);
        const [row] = await this.ds.query(`SELECT * FROM tp_round WHERE id = ?`, [id]);
        return row;
    }
    /** Turn the cards over and pay. Runs once per round, whoever triggers it. */
    async settleRound(roundId) {
        const claim = await this.ds.query(`UPDATE tp_round SET status = 'closed' WHERE id = ? AND status = 'open'`, [roundId]);
        if (!claim.affectedRows)
            return null;
        const [round] = await this.ds.query(`SELECT * FROM tp_round WHERE id = ?`, [roundId]);
        const { handA, handB } = TeenPattiService_1.deal(round.server_seed, round.round_no);
        const rankA = TeenPattiService_1.rankHand(handA);
        const rankB = TeenPattiService_1.rankHand(handB);
        const winner = TeenPattiService_1.compare(handA, handB);
        const payouts = await this.payouts();
        const payoutFor = (rank) => {
            const row = payouts.find((p) => p.hand_rank === rank);
            return row ? new decimal_js_1.default(row.payout) : null;
        };
        const bets = await this.ds.query(`SELECT * FROM tp_bet WHERE round_id = ? AND status = 'open'`, [roundId]);
        let paid = new decimal_js_1.default(0);
        await this.ledger.inTx(async (qr) => {
            for (const bet of bets) {
                const hand = bet.selection === 'A' ? handA : handB;
                const rank = (bet.selection === 'A' ? rankA : rankB).rank;
                let payout = new decimal_js_1.default(0);
                let result = 'lost';
                if (bet.market === 'match') {
                    if (winner === 'tie') {
                        // Nobody wins a tied deal; stakes go back.
                        payout = new decimal_js_1.default(bet.liability);
                        result = 'void';
                    }
                    else {
                        const backed = bet.side === 'back';
                        const hit = winner === bet.selection;
                        if (backed === hit) {
                            // Return what was held plus the profit.
                            const profit = backed
                                ? new decimal_js_1.default(bet.stake).mul(new decimal_js_1.default(bet.odds).minus(1))
                                : new decimal_js_1.default(bet.stake);
                            payout = new decimal_js_1.default(bet.liability).plus(profit);
                            result = 'won';
                        }
                    }
                }
                else {
                    // Pair Plus: pays on the strength of that hand alone.
                    const table = payoutFor(rank);
                    if (table) {
                        payout = new decimal_js_1.default(bet.stake).plus(new decimal_js_1.default(bet.stake).mul(table));
                        result = 'won';
                    }
                }
                if (payout.gt(0)) {
                    await this.ledger.move(qr, {
                        userId: bet.user_id,
                        currency: bet.currency,
                        delta: payout,
                        reference: `tp:stl:${bet.id}`,
                        meta: { roundNo: round.round_no, market: bet.market, selection: bet.selection, result },
                    });
                    paid = paid.plus(payout);
                }
                await qr.query(`UPDATE tp_bet SET status = ?, result = ?, payout = ? WHERE id = ? AND status = 'open'`, [result === 'void' ? 'void' : 'settled', result, payout.toFixed(2), bet.id]);
            }
            await qr.query(`UPDATE tp_round SET status='settled', hand_a=?, hand_b=?, rank_a=?, rank_b=?, winner=?, settled_at=NOW(), paid=?
          WHERE id = ?`, [handA.join(','), handB.join(','), rankA.rank, rankB.rank, winner, paid.toFixed(2), roundId]);
        });
        return { roundId, winner, handA, handB, bets: bets.length, paid: paid.toFixed(2) };
    }
    // ------------------------------------------------------------ betting
    async placeBet(p) {
        const cfg = await this.config();
        if (cfg.enabled !== '1')
            throw new TpError('The table is closed right now.');
        if (!['A', 'B'].includes(p.selection))
            throw new TpError('Choose Player A or Player B.');
        if (!['match', 'pairplus'].includes(p.market))
            throw new TpError('Unknown market.');
        if (p.market === 'pairplus') {
            if (cfg.pairplus_enabled !== '1')
                throw new TpError('Pair Plus is closed.');
            if (p.side !== 'back')
                throw new TpError('Pair Plus is back only.');
        }
        if (!['back', 'lay'].includes(p.side))
            throw new TpError('Choose back or lay.');
        if (!/^\d+(\.\d{1,2})?$/.test(String(p.stake)))
            throw new TpError('Enter a valid amount.');
        const stake = new decimal_js_1.default(p.stake);
        const min = new decimal_js_1.default(cfg.min_stake ?? 200);
        const max = new decimal_js_1.default(cfg.max_stake ?? 300000);
        if (stake.lt(min))
            throw new TpError(`Minimum is ${min.toFixed(0)}.`);
        if (stake.gt(max))
            throw new TpError(`Maximum is ${max.toFixed(0)}.`);
        await (0, max_bet_util_1.assertWithinMaxBet)(this.ds, p.userId, 'goldenflower', Number(stake)).catch((e) => { throw new TpError(e.message); });
        const round = await this.tick();
        if (!round)
            throw new TpError('No round is running.');
        // Pair Plus has no single price: it pays from the table, so odds are 0 here.
        const odds = p.market === 'match'
            ? new decimal_js_1.default(p.side === 'back' ? (cfg.match_back_odds ?? 1.95) : (cfg.match_lay_odds ?? 1.95))
            : new decimal_js_1.default(0);
        // Back risks the stake; lay risks the profit it would have to pay.
        const liability = p.market === 'pairplus' || p.side === 'back'
            ? stake
            : stake.mul(odds.minus(1));
        const id = (0, node_crypto_1.randomUUID)();
        const reference = ledger_service_1.LedgerService.reference('TP');
        await this.ledger.inTx(async (qr) => {
            const [fresh] = await qr.query(`SELECT status, closes_at > NOW() AS live FROM tp_round WHERE id = ? FOR UPDATE`, [round.id]);
            if (!fresh || fresh.status !== 'open' || !Number(fresh.live)) {
                throw new TpError('No more bets on this round. Wait for the next deal.');
            }
            await this.ledger.move(qr, {
                userId: p.userId, currency: p.currency, delta: liability.negated(),
                reference: `tp:bet:${id}`,
                meta: { roundNo: round.round_no, market: p.market, selection: p.selection, side: p.side },
            });
            await qr.query(`INSERT INTO tp_bet (id, reference, round_id, user_id, currency, market, selection, side, odds, stake, liability)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [id, reference, round.id, p.userId, p.currency, p.market, p.selection, p.side,
                odds.toFixed(3), stake.toFixed(2), liability.toFixed(2)]);
            await qr.query(`UPDATE tp_round SET staked = staked + ? WHERE id = ?`, [stake.toFixed(2), round.id]);
        });
        return {
            id, reference, roundNo: round.round_no,
            market: p.market, selection: p.selection, side: p.side,
            odds: odds.toFixed(2), stake: stake.toFixed(2), liability: liability.toFixed(2),
        };
    }
    /** Everything the table screen needs, in one call. */
    async state(userId) {
        const cfg = await this.config();
        const round = await this.tick();
        const payouts = await this.payouts();
        const myBets = userId && round
            ? await this.ds.query(`SELECT market, selection, side, odds, SUM(stake) AS stake, SUM(liability) AS liability
             FROM tp_bet WHERE round_id = ? AND user_id = ?
            GROUP BY market, selection, side, odds`, [round.id, userId])
            : [];
        const history = await this.ds.query(`SELECT round_no, hand_a, hand_b, rank_a, rank_b, winner, settled_at, server_seed, server_seed_hash
         FROM tp_round WHERE status = 'settled' ORDER BY round_no DESC LIMIT 20`);
        const last = history[0];
        return {
            enabled: cfg.enabled === '1',
            pairPlusEnabled: cfg.pairplus_enabled === '1',
            minStake: Number(cfg.min_stake ?? 200).toFixed(0),
            maxStake: Number(cfg.max_stake ?? 300000).toFixed(0),
            backOdds: Number(cfg.match_back_odds ?? 1.95).toFixed(2),
            layOdds: Number(cfg.match_lay_odds ?? 1.95).toFixed(2),
            payouts: payouts.map((p) => ({ rank: p.hand_rank, label: p.label, payout: Number(p.payout).toFixed(0) })),
            round: round
                ? {
                    no: round.round_no,
                    hash: round.server_seed_hash,
                    secondsLeft: Math.max(0, Math.round((new Date(round.closes_at).getTime() - Date.now()) / 1000)),
                    staked: Number(round.staked ?? 0).toFixed(2),
                }
                : null,
            myBets: myBets.map((b) => ({
                market: b.market, selection: b.selection, side: b.side,
                odds: Number(b.odds).toFixed(2),
                stake: Number(b.stake).toFixed(2),
                liability: Number(b.liability).toFixed(2),
            })),
            lastResult: last
                ? {
                    roundNo: last.round_no,
                    handA: String(last.hand_a).split(','),
                    handB: String(last.hand_b).split(','),
                    rankA: last.rank_a, rankB: last.rank_b,
                    winner: last.winner, seed: last.server_seed,
                }
                : null,
            history: history.map((h) => ({ roundNo: h.round_no, winner: h.winner })),
        };
    }
    async myRecentBets(userId, limit = 30) {
        const rows = await this.ds.query(`SELECT b.reference, b.market, b.selection, b.side, b.odds, b.stake, b.liability,
              b.payout, b.result, b.status, b.placed_at, r.round_no, r.winner
         FROM tp_bet b JOIN tp_round r ON r.id = b.round_id
        WHERE b.user_id = ? ORDER BY b.placed_at DESC LIMIT ?`, [userId, Math.min(Math.max(limit, 1), 100)]);
        return rows.map((b) => ({
            reference: b.reference, roundNo: b.round_no, market: b.market,
            selection: b.selection, side: b.side,
            odds: Number(b.odds).toFixed(2),
            stake: Number(b.stake).toFixed(2),
            payout: b.payout === null ? null : Number(b.payout).toFixed(2),
            result: b.result, status: b.status, placedAt: b.placed_at, winner: b.winner,
        }));
    }
};
exports.TeenPattiService = TeenPattiService;
exports.TeenPattiService = TeenPattiService = TeenPattiService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [typeorm_1.DataSource,
        ledger_service_1.LedgerService])
], TeenPattiService);
