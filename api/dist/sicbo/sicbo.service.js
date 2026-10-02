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
var SicBoService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.SicBoService = exports.SbError = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("typeorm");
const node_crypto_1 = require("node:crypto");
const decimal_js_1 = __importDefault(require("decimal.js"));
const ledger_service_1 = require("../platform/ledger.service");
class SbError extends Error {
}
exports.SbError = SbError;
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
let SicBoService = SicBoService_1 = class SicBoService {
    ds;
    ledger;
    log = new common_1.Logger(SicBoService_1.name);
    constructor(ds, ledger) {
        this.ds = ds;
        this.ledger = ledger;
    }
    async config() {
        const rows = await this.ds.query(`SELECT key_name, value FROM sb_config`);
        const out = {};
        for (const r of rows)
            out[r.key_name] = r.value;
        return out;
    }
    async payouts() {
        return this.ds.query(`SELECT market, selection, label, payout FROM sb_payout ORDER BY sort_order`);
    }
    /** Roll three dice deterministically from the seed. */
    static roll(serverSeed, roundNo) {
        const h = (0, node_crypto_1.createHash)('sha256').update(`${serverSeed}:${roundNo}`).digest('hex');
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
    static evaluate(market, selection, baseRate, roll) {
        const dice = [roll.d1, roll.d2, roll.d3];
        const triple = roll.d1 === roll.d2 && roll.d2 === roll.d3;
        const t = roll.total;
        switch (market) {
            case 'smallbig':
                if (triple)
                    return 0; // small/big lose to any triple
                if (selection === 'small')
                    return t >= 4 && t <= 10 ? baseRate : 0;
                if (selection === 'big')
                    return t >= 11 && t <= 17 ? baseRate : 0;
                return 0;
            case 'oddeven':
                if (triple)
                    return 0;
                if (selection === 'odd')
                    return t % 2 === 1 ? baseRate : 0;
                if (selection === 'even')
                    return t % 2 === 0 ? baseRate : 0;
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
        if (cfg.enabled !== '1')
            return null;
        const due = await this.ds.query(`SELECT id FROM sb_round WHERE status='open' AND closes_at <= NOW() ORDER BY round_no LIMIT 5`);
        for (const r of due)
            await this.settleRound(r.id).catch((e) => this.log.warn(`settle ${r.id}: ${e.message}`));
        const [live] = await this.ds.query(`SELECT * FROM sb_round WHERE status='open' AND closes_at > NOW() ORDER BY round_no DESC LIMIT 1`);
        return live ?? (await this.openRound(Number(cfg.round_seconds ?? 25)));
    }
    async openRound(seconds) {
        const id = (0, node_crypto_1.randomUUID)();
        const seed = (0, node_crypto_1.randomBytes)(32).toString('hex');
        const hash = (0, node_crypto_1.createHash)('sha256').update(seed).digest('hex');
        await this.ds.query(`INSERT INTO sb_round (id, server_seed, server_seed_hash, closes_at)
       VALUES (?,?,?, DATE_ADD(NOW(), INTERVAL ? SECOND))`, [id, seed, hash, Math.max(10, Math.min(300, seconds))]);
        const [row] = await this.ds.query(`SELECT * FROM sb_round WHERE id=?`, [id]);
        return row;
    }
    async settleRound(roundId) {
        const claim = await this.ds.query(`UPDATE sb_round SET status='closed' WHERE id=? AND status='open'`, [roundId]);
        if (!claim.affectedRows)
            return null;
        const [round] = await this.ds.query(`SELECT * FROM sb_round WHERE id=?`, [roundId]);
        const roll = SicBoService_1.roll(round.server_seed, round.round_no);
        const bets = await this.ds.query(`SELECT * FROM sb_bet WHERE round_id=? AND status='open'`, [roundId]);
        let paid = new decimal_js_1.default(0);
        await this.ledger.inTx(async (qr) => {
            for (const bet of bets) {
                const mult = SicBoService_1.evaluate(bet.market, bet.selection, Number(bet.payout_rate), roll);
                if (mult > 0) {
                    const payout = new decimal_js_1.default(bet.stake).plus(new decimal_js_1.default(bet.stake).mul(mult));
                    await this.ledger.move(qr, {
                        userId: bet.user_id, currency: bet.currency, delta: payout,
                        reference: `sb:win:${bet.id}`,
                        meta: { roundNo: round.round_no, market: bet.market, selection: bet.selection, roll: `${roll.d1}-${roll.d2}-${roll.d3}` },
                    });
                    await qr.query(`UPDATE sb_bet SET status='settled', result='won', payout=? WHERE id=? AND status='open'`, [payout.toFixed(2), bet.id]);
                    paid = paid.plus(payout);
                }
                else {
                    await qr.query(`UPDATE sb_bet SET status='settled', result='lost', payout=0 WHERE id=? AND status='open'`, [bet.id]);
                }
            }
            await qr.query(`UPDATE sb_round SET status='settled', d1=?, d2=?, d3=?, total=?, settled_at=NOW(), paid=? WHERE id=?`, [roll.d1, roll.d2, roll.d3, roll.total, paid.toFixed(2), roundId]);
        });
        return { roundId, roll, bets: bets.length, paid: paid.toFixed(2) };
    }
    // ------------------------------------------------------------ betting
    async placeBet(p) {
        const cfg = await this.config();
        if (cfg.enabled !== '1')
            throw new SbError('The table is closed right now.');
        const [rate] = await this.ds.query(`SELECT payout FROM sb_payout WHERE market=? AND selection=?`, [p.market, p.selection]);
        if (!rate)
            throw new SbError('That selection is not available.');
        if (!/^\d+(\.\d{1,2})?$/.test(String(p.stake)))
            throw new SbError('Enter a valid amount.');
        const stake = new decimal_js_1.default(p.stake);
        const min = new decimal_js_1.default(cfg.min_stake ?? 100);
        const max = new decimal_js_1.default(cfg.max_stake ?? 50000);
        if (stake.lt(min))
            throw new SbError(`Minimum is ${min.toFixed(0)}.`);
        if (stake.gt(max))
            throw new SbError(`Maximum is ${max.toFixed(0)}.`);
        const round = await this.tick();
        if (!round)
            throw new SbError('No round is running.');
        // Per-selection exposure cap: limit the house's potential payout on one
        // selection in a round. 0 = no cap. Single die can pay x3, so size at x3.
        const cap = new decimal_js_1.default(cfg.max_exposure_per_selection ?? 0);
        if (cap.gt(0)) {
            const worst = p.market === 'single' ? new decimal_js_1.default(rate.payout).mul(3) : new decimal_js_1.default(rate.payout);
            const [ex] = await this.ds.query(`SELECT COALESCE(SUM(stake * (1 + payout_rate * ?)),0) AS exposure
           FROM sb_bet WHERE round_id=? AND market=? AND selection=? AND status='open'`, [p.market === 'single' ? 3 : 1, round.id, p.market, p.selection]);
            const wouldBe = new decimal_js_1.default(ex?.exposure ?? 0).plus(stake.mul(worst.plus(1)));
            if (wouldBe.gt(cap))
                throw new SbError('This selection is full for this round. Try another or wait for the next round.');
        }
        const id = (0, node_crypto_1.randomUUID)();
        const reference = ledger_service_1.LedgerService.reference('SB');
        await this.ledger.inTx(async (qr) => {
            const [fresh] = await qr.query(`SELECT status, closes_at > NOW() AS live FROM sb_round WHERE id=? FOR UPDATE`, [round.id]);
            if (!fresh || fresh.status !== 'open' || !Number(fresh.live))
                throw new SbError('No more bets on this round. Wait for the next roll.');
            await this.ledger.move(qr, {
                userId: p.userId, currency: p.currency, delta: stake.negated(),
                reference: `sb:bet:${id}`, meta: { roundNo: round.round_no, market: p.market, selection: p.selection },
            });
            await qr.query(`INSERT INTO sb_bet (id, reference, round_id, user_id, currency, market, selection, payout_rate, stake)
         VALUES (?,?,?,?,?,?,?,?,?)`, [id, reference, round.id, p.userId, p.currency, p.market, p.selection, new decimal_js_1.default(rate.payout).toFixed(3), stake.toFixed(2)]);
            await qr.query(`UPDATE sb_round SET staked = staked + ? WHERE id=?`, [stake.toFixed(2), round.id]);
        });
        return {
            id, reference, roundNo: round.round_no, market: p.market, selection: p.selection,
            rate: new decimal_js_1.default(rate.payout).toFixed(2), stake: stake.toFixed(2),
        };
    }
    async state(userId) {
        const cfg = await this.config();
        const payouts = await this.payouts();
        const round = await this.tick();
        const myBets = userId && round
            ? await this.ds.query(`SELECT market, selection, payout_rate, SUM(stake) AS stake
             FROM sb_bet WHERE round_id=? AND user_id=? GROUP BY market, selection, payout_rate`, [round.id, userId])
            : [];
        const history = await this.ds.query(`SELECT round_no, d1, d2, d3, total, server_seed, server_seed_hash, settled_at
         FROM sb_round WHERE status='settled' ORDER BY round_no DESC LIMIT 20`);
        const last = history[0];
        return {
            enabled: cfg.enabled === '1',
            minStake: Number(cfg.min_stake ?? 100).toFixed(0),
            maxStake: Number(cfg.max_stake ?? 50000).toFixed(0),
            roundSeconds: Number(cfg.round_seconds ?? 25),
            payouts: payouts.map((p) => ({ market: p.market, selection: p.selection, label: p.label, rate: Number(p.payout).toFixed(2) })),
            round: round ? {
                no: round.round_no, hash: round.server_seed_hash,
                secondsLeft: Math.max(0, Math.round((new Date(round.closes_at).getTime() - Date.now()) / 1000)),
                staked: Number(round.staked ?? 0).toFixed(2),
            } : null,
            myBets: myBets.map((b) => ({ market: b.market, selection: b.selection, stake: Number(b.stake).toFixed(2) })),
            lastResult: last ? {
                roundNo: last.round_no, d1: last.d1, d2: last.d2, d3: last.d3, total: last.total, seed: last.server_seed,
            } : null,
            history: history.map((h) => ({ roundNo: h.round_no, d1: h.d1, d2: h.d2, d3: h.d3, total: h.total })),
        };
    }
    async myRecentBets(userId, limit = 30) {
        const rows = await this.ds.query(`SELECT b.reference, b.market, b.selection, b.payout_rate, b.stake, b.payout, b.result, b.status, b.placed_at, r.round_no, r.total
         FROM sb_bet b JOIN sb_round r ON r.id = b.round_id
        WHERE b.user_id=? ORDER BY b.placed_at DESC LIMIT ?`, [userId, Math.min(Math.max(limit, 1), 100)]);
        return rows.map((b) => ({
            reference: b.reference, roundNo: b.round_no, market: b.market, selection: b.selection,
            rate: Number(b.payout_rate).toFixed(2), stake: Number(b.stake).toFixed(2),
            payout: b.payout === null ? null : Number(b.payout).toFixed(2), result: b.result, status: b.status, placedAt: b.placed_at,
        }));
    }
};
exports.SicBoService = SicBoService;
exports.SicBoService = SicBoService = SicBoService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [typeorm_1.DataSource, ledger_service_1.LedgerService])
], SicBoService);
