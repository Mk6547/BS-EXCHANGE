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
var WheelService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.WheelService = exports.WheelError = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("typeorm");
const node_crypto_1 = require("node:crypto");
const decimal_js_1 = __importDefault(require("decimal.js"));
const ledger_service_1 = require("../platform/ledger.service");
const max_bet_util_1 = require("../agents/max-bet.util");
class WheelError extends Error {
}
exports.WheelError = WheelError;
/**
 * Food wheel — an instant game that settles itself.
 *
 * Rounds are driven by the clock, not by a background timer: every request
 * calls tick(), which settles anything that has expired and opens the next
 * round. Passenger puts idle Node processes to sleep on shared hosting, so a
 * setInterval would silently stop; this design cannot.
 *
 * Fairness: when a round opens, the server generates a secret seed and stores
 * only its hash for players to see. The winning slot is derived from that seed,
 * so it is decided before any bet is placed and cannot be changed afterwards.
 * Once the round settles, the seed is published and anyone can recompute the
 * result and check it against the hash they were shown.
 */
let WheelService = WheelService_1 = class WheelService {
    ds;
    ledger;
    log = new common_1.Logger(WheelService_1.name);
    constructor(ds, ledger) {
        this.ds = ds;
        this.ledger = ledger;
    }
    async config() {
        const rows = await this.ds.query(`SELECT key_name, value FROM wheel_config`);
        const out = {};
        for (const r of rows)
            out[r.key_name] = r.value;
        return out;
    }
    async items() {
        return this.ds.query(`SELECT id, name, icon, color, multiplier, slots, enabled, sort_order
         FROM wheel_item WHERE enabled = 1 ORDER BY sort_order, name`);
    }
    /** Winning slot for a round, straight from its seed. Anyone can repeat this. */
    static resolveSlot(serverSeed, roundNo, totalSlots) {
        const digest = (0, node_crypto_1.createHash)('sha256').update(`${serverSeed}:${roundNo}`).digest('hex');
        // 52 bits keeps the result inside a safe integer.
        return Number(BigInt('0x' + digest.slice(0, 13)) % BigInt(totalSlots));
    }
    /** How much of every 100 staked comes back to players, per item. */
    static rtpOf(items) {
        const total = items.reduce((s, i) => s + Number(i.slots), 0) || 1;
        return items.map((i) => ({
            id: i.id,
            name: i.name,
            chancePct: +((Number(i.slots) / total) * 100).toFixed(2),
            rtpPct: +(((Number(i.slots) / total) * Number(i.multiplier)) * 100).toFixed(2),
        }));
    }
    // ------------------------------------------------------------- scheduling
    /**
     * Bring the game up to date: settle finished rounds, open one if none is
     * running. Safe to call on every request; returns the live round.
     */
    async tick() {
        const cfg = await this.config();
        if (cfg.enabled !== '1')
            return null;
        const due = await this.ds.query(`SELECT id FROM wheel_round WHERE status = 'open' AND closes_at <= NOW() ORDER BY round_no LIMIT 5`);
        for (const r of due)
            await this.settleRound(r.id).catch((e) => this.log.warn(`settle ${r.id}: ${e.message}`));
        const [live] = await this.ds.query(`SELECT * FROM wheel_round WHERE status = 'open' AND closes_at > NOW() ORDER BY round_no DESC LIMIT 1`);
        return live ?? (await this.openRound(Number(cfg.round_seconds ?? 30)));
    }
    async openRound(seconds) {
        const items = await this.items();
        if (!items.length)
            throw new WheelError('No wheel items are enabled.');
        const totalSlots = items.reduce((s, i) => s + Number(i.slots), 0);
        const id = (0, node_crypto_1.randomUUID)();
        const serverSeed = (0, node_crypto_1.randomBytes)(32).toString('hex');
        const hash = (0, node_crypto_1.createHash)('sha256').update(serverSeed).digest('hex');
        await this.ds.query(`INSERT INTO wheel_round (id, server_seed, server_seed_hash, total_slots, closes_at)
       VALUES (?,?,?,?, DATE_ADD(NOW(), INTERVAL ? SECOND))`, [id, serverSeed, hash, totalSlots, Math.max(10, Math.min(300, seconds))]);
        const [row] = await this.ds.query(`SELECT * FROM wheel_round WHERE id = ?`, [id]);
        return row;
    }
    /** Reveal the winner and pay everyone who backed it. Runs once per round. */
    async settleRound(roundId) {
        // Claim the round first: two requests arriving together must not both pay.
        const claim = await this.ds.query(`UPDATE wheel_round SET status = 'closed' WHERE id = ? AND status = 'open'`, [roundId]);
        if (!claim.affectedRows)
            return null;
        const [round] = await this.ds.query(`SELECT * FROM wheel_round WHERE id = ?`, [roundId]);
        const items = await this.items();
        const totalSlots = round.total_slots || items.reduce((s, i) => s + Number(i.slots), 0);
        const slot = WheelService_1.resolveSlot(round.server_seed, round.round_no, totalSlots);
        let cursor = 0;
        let winner = items[items.length - 1];
        for (const item of items) {
            cursor += Number(item.slots);
            if (slot < cursor) {
                winner = item;
                break;
            }
        }
        const bets = await this.ds.query(`SELECT * FROM wheel_bet WHERE round_id = ? AND status = 'open'`, [roundId]);
        let paid = new decimal_js_1.default(0);
        await this.ledger.inTx(async (qr) => {
            for (const bet of bets) {
                if (bet.item_id === winner.id) {
                    const payout = new decimal_js_1.default(bet.stake).mul(bet.multiplier);
                    await this.ledger.move(qr, {
                        userId: bet.user_id,
                        currency: bet.currency,
                        delta: payout,
                        reference: `wh:win:${bet.id}`,
                        meta: { roundNo: round.round_no, item: winner.name, multiplier: bet.multiplier },
                    });
                    await qr.query(`UPDATE wheel_bet SET status='won', payout=? WHERE id = ? AND status='open'`, [payout.toFixed(2), bet.id]);
                    paid = paid.plus(payout);
                }
                else {
                    // The stake left the wallet when the bet was placed.
                    await qr.query(`UPDATE wheel_bet SET status='lost', payout=0 WHERE id = ? AND status='open'`, [bet.id]);
                }
            }
            await qr.query(`UPDATE wheel_round SET status='settled', winning_item_id=?, winning_slot=?, settled_at=NOW(), paid=?
          WHERE id = ?`, [winner.id, slot, paid.toFixed(2), roundId]);
        });
        return { roundId, winner: winner.name, bets: bets.length, paid: paid.toFixed(2) };
    }
    // ---------------------------------------------------------------- betting
    async placeBet(p) {
        const cfg = await this.config();
        if (cfg.enabled !== '1')
            throw new WheelError('The wheel is closed right now.');
        const round = await this.tick();
        if (!round)
            throw new WheelError('No round is running.');
        if (!/^\d+(\.\d{1,2})?$/.test(String(p.stake)))
            throw new WheelError('Enter a valid amount.');
        const stake = new decimal_js_1.default(p.stake);
        const min = new decimal_js_1.default(cfg.min_stake ?? 100);
        const max = new decimal_js_1.default(cfg.max_stake_per_item ?? 10000);
        if (stake.lt(min))
            throw new WheelError(`Minimum is ${min.toFixed(0)}.`);
        if (stake.gt(max))
            throw new WheelError(`Maximum is ${max.toFixed(0)} on one item.`);
        await (0, max_bet_util_1.assertWithinMaxBet)(this.ds, p.userId, 'wheel', Number(stake)).catch((e) => { throw new WheelError(e.message); });
        const [item] = await this.ds.query(`SELECT * FROM wheel_item WHERE id = ? AND enabled = 1`, [p.itemId]);
        if (!item)
            throw new WheelError('That item is not available.');
        // At most N different items per player per round; topping up one of your
        // own picks is fine.
        const mine = await this.ds.query(`SELECT item_id, SUM(stake) AS staked FROM wheel_bet
        WHERE round_id = ? AND user_id = ? AND status = 'open' GROUP BY item_id`, [round.id, p.userId]);
        const maxItems = Number(cfg.max_items_per_round ?? 2);
        const already = mine.find((m) => m.item_id === p.itemId);
        if (!already && mine.length >= maxItems) {
            throw new WheelError(`You can back ${maxItems} items in one round.`);
        }
        if (already && new decimal_js_1.default(already.staked).plus(stake).gt(max)) {
            throw new WheelError(`Maximum is ${max.toFixed(0)} on one item.`);
        }
        const id = (0, node_crypto_1.randomUUID)();
        const reference = ledger_service_1.LedgerService.reference('WH');
        await this.ledger.inTx(async (qr) => {
            // Re-check inside the transaction: the round may have closed a moment ago.
            const [fresh] = await qr.query(`SELECT status, closes_at > NOW() AS live FROM wheel_round WHERE id = ? FOR UPDATE`, [round.id]);
            if (!fresh || fresh.status !== 'open' || !Number(fresh.live)) {
                throw new WheelError('Betting for this round has closed. Try the next one.');
            }
            await this.ledger.move(qr, {
                userId: p.userId,
                currency: p.currency,
                delta: stake.negated(),
                reference: `wh:bet:${id}`,
                meta: { roundNo: round.round_no, item: item.name },
            });
            await qr.query(`INSERT INTO wheel_bet (id, reference, round_id, user_id, currency, item_id, item_name, multiplier, stake)
         VALUES (?,?,?,?,?,?,?,?,?)`, [id, reference, round.id, p.userId, p.currency, item.id, item.name, item.multiplier, stake.toFixed(2)]);
            await qr.query(`UPDATE wheel_round SET staked = staked + ? WHERE id = ?`, [stake.toFixed(2), round.id]);
        });
        return {
            id,
            reference,
            roundNo: round.round_no,
            item: item.name,
            multiplier: Number(item.multiplier).toFixed(2),
            stake: stake.toFixed(2),
            toWin: stake.mul(item.multiplier).toFixed(2),
        };
    }
    /** Everything the game screen needs in one call. */
    async state(userId) {
        const cfg = await this.config();
        const items = await this.items();
        const round = await this.tick();
        const myBets = userId && round
            ? await this.ds.query(`SELECT item_id, item_name, multiplier, SUM(stake) AS stake
             FROM wheel_bet WHERE round_id = ? AND user_id = ? GROUP BY item_id, item_name, multiplier`, [round.id, userId])
            : [];
        const history = await this.ds.query(`SELECT r.round_no, r.winning_item_id, r.winning_slot, r.server_seed, r.server_seed_hash,
              i.name AS item_name, i.icon, i.multiplier, r.settled_at
         FROM wheel_round r LEFT JOIN wheel_item i ON i.id = r.winning_item_id
        WHERE r.status = 'settled' ORDER BY r.round_no DESC LIMIT 20`);
        return {
            enabled: cfg.enabled === '1',
            minStake: Number(cfg.min_stake ?? 100).toFixed(0),
            maxStake: Number(cfg.max_stake_per_item ?? 10000).toFixed(0),
            maxItems: Number(cfg.max_items_per_round ?? 2),
            roundSeconds: Number(cfg.round_seconds ?? 30),
            items: items.map((i) => ({
                id: i.id, name: i.name, icon: i.icon, color: i.color,
                multiplier: Number(i.multiplier).toFixed(2),
            })),
            round: round
                ? {
                    no: round.round_no,
                    hash: round.server_seed_hash, // proof, published before betting
                    closesAt: round.closes_at,
                    secondsLeft: Math.max(0, Math.round((new Date(round.closes_at).getTime() - Date.now()) / 1000)),
                    staked: Number(round.staked ?? 0).toFixed(2),
                }
                : null,
            myBets: myBets.map((b) => ({
                itemId: b.item_id, item: b.item_name,
                stake: Number(b.stake).toFixed(2),
                toWin: (Number(b.stake) * Number(b.multiplier)).toFixed(2),
            })),
            history: history.map((h) => ({
                roundNo: h.round_no, item: h.item_name, icon: h.icon,
                multiplier: h.multiplier ? Number(h.multiplier).toFixed(2) : null,
                settledAt: h.settled_at,
                // Published after settlement so the round can be checked.
                seed: h.server_seed, hash: h.server_seed_hash, slot: h.winning_slot,
            })),
        };
    }
    async myRecentBets(userId, limit = 30) {
        const rows = await this.ds.query(`SELECT b.reference, b.item_name, b.multiplier, b.stake, b.payout, b.status, b.placed_at, r.round_no
         FROM wheel_bet b JOIN wheel_round r ON r.id = b.round_id
        WHERE b.user_id = ? ORDER BY b.placed_at DESC LIMIT ?`, [userId, Math.min(Math.max(limit, 1), 100)]);
        return rows.map((b) => ({
            reference: b.reference, roundNo: b.round_no, item: b.item_name,
            multiplier: Number(b.multiplier).toFixed(2),
            stake: Number(b.stake).toFixed(2),
            payout: b.payout === null ? null : Number(b.payout).toFixed(2),
            status: b.status, placedAt: b.placed_at,
        }));
    }
};
exports.WheelService = WheelService;
exports.WheelService = WheelService = WheelService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [typeorm_1.DataSource,
        ledger_service_1.LedgerService])
], WheelService);
