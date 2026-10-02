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
var SportsService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.SportsService = exports.BetError = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("typeorm");
const node_crypto_1 = require("node:crypto");
const decimal_js_1 = __importDefault(require("decimal.js"));
const ledger_service_1 = require("../platform/ledger.service");
const max_bet_util_1 = require("../agents/max-bet.util");
const owner_suspend_util_1 = require("../agents/owner-suspend.util");
class BetError extends Error {
}
exports.BetError = BetError;
/**
 * Sports betting against the house.
 *
 * There is no order book: a back or lay bet is accepted at the displayed price
 * and the house takes the other side. That is how the Bet Pro style sites in
 * this market actually work, and it means a bet is either open or settled —
 * there is no "unmatched" state to manage.
 *
 * Money rule: the liability is debited when the bet is placed, so the wallet
 * balance is always what the player can still spend. Settlement credits the
 * liability back plus the profit when the bet wins, and nothing when it loses.
 */
let SportsService = SportsService_1 = class SportsService {
    ds;
    ledger;
    log = new common_1.Logger(SportsService_1.name);
    constructor(ds, ledger) {
        this.ds = ds;
        this.ledger = ledger;
    }
    // ------------------------------------------------------------------ maths
    /**
     * Profit and liability for one bet. The only place these are worked out —
     * the admin panel and the player app both read the numbers this returns.
     */
    static shape(p) {
        const s = p.stake;
        if (p.marketType === 'fancy') {
            const rate = p.rate ?? new decimal_js_1.default(100);
            return p.side === 'yes'
                ? { profit: s.mul(rate).div(100), liability: s }
                : { profit: s, liability: s.mul(rate).div(100) };
        }
        if (p.marketType === 'bookmaker') {
            return p.side === 'back'
                ? { profit: s.mul(p.odds).div(100), liability: s }
                : { profit: s, liability: s.mul(p.odds).div(100) };
        }
        // Exchange odds: 2.50 means 1.5 profit per 1 staked.
        return p.side === 'back'
            ? { profit: s.mul(p.odds.minus(1)), liability: s }
            : { profit: s, liability: s.mul(p.odds.minus(1)) };
    }
    async config() {
        const rows = await this.ds.query(`SELECT key_name, value FROM sports_config`);
        const out = {};
        for (const r of rows)
            out[r.key_name] = r.value;
        return out;
    }
    // -------------------------------------------------------------- placement
    async placeBet(p) {
        const cfg = await this.config();
        if (cfg.betting_enabled !== '1')
            throw new BetError('Sports betting is closed right now.');
        if (!/^\d+(\.\d{1,2})?$/.test(String(p.stake)))
            throw new BetError('Enter a valid stake.');
        const stake = new decimal_js_1.default(p.stake);
        const askedOdds = new decimal_js_1.default(p.odds);
        if (askedOdds.lte(0))
            throw new BetError('That price is no longer available.');
        const [row] = await this.ds.query(`SELECT r.id AS runner_id, r.name AS runner_name, r.status AS runner_status,
              r.back_price, r.lay_price, r.back_rate, r.lay_rate, r.line_value,
              m.id AS market_id, m.name AS market_name, m.type AS market_type, m.status AS market_status,
              m.min_stake, m.max_stake, m.max_liability, m.inplay_allowed,
              e.id AS event_id, e.name AS event_name, e.status AS event_status, e.inplay
         FROM runner r
         JOIN market m ON m.id = r.market_id
         JOIN sport_event e ON e.id = m.event_id
        WHERE r.id = ? AND m.id = ?`, [p.runnerId, p.marketId]);
        if (!row)
            throw new BetError('That selection no longer exists.');
        if (row.runner_status !== 'active')
            throw new BetError('That selection is not available.');
        if (row.market_status !== 'open')
            throw new BetError('That market is suspended.');
        if (!['open', 'inplay'].includes(row.event_status))
            throw new BetError('Betting on this match is closed.');
        if (row.inplay && !row.inplay_allowed)
            throw new BetError('This market is not open for in-play betting.');
        const fancy = row.market_type === 'fancy';
        if (fancy && !['yes', 'no'].includes(p.side))
            throw new BetError('Choose yes or no.');
        if (!fancy && !['back', 'lay'].includes(p.side))
            throw new BetError('Choose back or lay.');
        // The price must still be the one on screen. A stale click is rejected
        // rather than quietly accepted at a worse price.
        const current = fancy
            ? new decimal_js_1.default(row.line_value ?? 0)
            : new decimal_js_1.default((p.side === 'back' ? row.back_price : row.lay_price) ?? 0);
        if (current.lte(0))
            throw new BetError('That price is no longer available.');
        if (!current.equals(askedOdds)) {
            throw new BetError(`The price changed to ${current.toFixed(2)}. Place the bet again to accept it.`);
        }
        const rate = fancy ? new decimal_js_1.default((p.side === 'yes' ? row.back_rate : row.lay_rate) ?? 100) : null;
        const min = new decimal_js_1.default(row.min_stake ?? cfg.default_min_stake ?? 100);
        const max = new decimal_js_1.default(row.max_stake ?? cfg.default_max_stake ?? 500000);
        if (stake.lt(min))
            throw new BetError(`Minimum stake is ${min.toFixed(0)}.`);
        if (stake.gt(max))
            throw new BetError(`Maximum stake is ${max.toFixed(0)}.`);
        const betCategory = row.market_type === 'fancy' ? 'fancy'
            : row.market_type === 'bookmaker' ? 'bookmaker'
                : row.sport === 'horse' ? 'races'
                    : row.sport === 'greyhound' ? 'greyhound'
                        : row.sport; // soccer | cricket | tennis
        await (0, max_bet_util_1.assertWithinMaxBet)(this.ds, p.userId, betCategory, Number(stake)).catch((e) => { throw new BetError(e.message); });
        await (0, owner_suspend_util_1.assertOwnerNotSuspended)(this.ds, p.userId, row.event_id).catch((e) => { throw new BetError(e.message); });
        const { profit, liability } = SportsService_1.shape({
            marketType: row.market_type, side: p.side, odds: current, rate, stake,
        });
        const [openCount] = await this.ds.query(`SELECT COUNT(*) AS n FROM sport_bet WHERE user_id = ? AND status = 'open'`, [p.userId]);
        if (Number(openCount.n) >= Number(cfg.max_open_bets_per_player ?? 200)) {
            throw new BetError('You have too many open bets. Wait for some to settle.');
        }
        const cap = row.max_liability ?? cfg.default_max_liability_per_market;
        if (cap) {
            const [used] = await this.ds.query(`SELECT COALESCE(SUM(liability),0) AS total FROM sport_bet
          WHERE user_id = ? AND market_id = ? AND status = 'open'`, [p.userId, row.market_id]);
            if (new decimal_js_1.default(used.total).plus(liability).gt(new decimal_js_1.default(cap))) {
                throw new BetError('This bet would go over your limit on this market.');
            }
        }
        const id = (0, node_crypto_1.randomUUID)();
        const reference = ledger_service_1.LedgerService.reference('SB');
        await this.ledger.inTx(async (qr) => {
            // Re-read the market inside the transaction: an admin may have suspended
            // it a moment ago, and a suspended market must not take money.
            const [locked] = await qr.query(`SELECT status FROM market WHERE id = ? FOR UPDATE`, [row.market_id]);
            if (locked.status !== 'open')
                throw new BetError('That market is suspended.');
            await this.ledger.move(qr, {
                userId: p.userId,
                currency: p.currency,
                delta: liability.negated(),
                reference: `sb:bet:${id}`,
                meta: { betId: id, marketId: row.market_id, side: p.side, odds: current.toFixed(2) },
            });
            await qr.query(`INSERT INTO sport_bet
           (id, reference, user_id, currency, event_id, market_id, runner_id, market_type, side,
            odds, rate, stake, potential_profit, liability, status,
            event_name, market_name, runner_name, ip)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'open', ?,?,?,?)`, [id, reference, p.userId, p.currency, row.event_id, row.market_id, row.runner_id,
                row.market_type, p.side, current.toFixed(3), rate ? rate.toFixed(2) : null,
                stake.toFixed(2), profit.toFixed(2), liability.toFixed(2),
                row.event_name, row.market_name, row.runner_name, p.ip ?? null]);
            await qr.query(`UPDATE sport_event SET matched = matched + ? WHERE id = ?`, [stake.toFixed(2), row.event_id]);
        });
        return {
            id,
            reference,
            status: 'open',
            side: p.side,
            odds: current.toFixed(2),
            rate: rate ? rate.toFixed(2) : null,
            stake: stake.toFixed(2),
            profit: profit.toFixed(2),
            liability: liability.toFixed(2),
            runner: row.runner_name,
            market: row.market_name,
            event: row.event_name,
        };
    }
    // ------------------------------------------------------------- settlement
    /**
     * Settle one market. Safe to run twice: each payout carries a unique ledger
     * reference, so a repeat attempt cannot pay a player a second time.
     *
     * winnerRunnerId — for match odds and bookmaker markets.
     * value          — for fancy markets: the number of runs that actually happened.
     */
    async settleMarket(p) {
        const [market] = await this.ds.query(`SELECT * FROM market WHERE id = ?`, [p.marketId]);
        if (!market)
            throw new BetError('No such market.');
        if (market.status === 'settled')
            throw new BetError('That market is already settled.');
        if (market.status === 'voided')
            throw new BetError('That market was voided.');
        const fancy = market.type === 'fancy';
        let value = null;
        if (fancy) {
            if (p.value === undefined || p.value === null || p.value === '')
                throw new BetError('Enter the actual result.');
            value = new decimal_js_1.default(p.value);
        }
        else {
            if (!p.winnerRunnerId)
                throw new BetError('Choose the winning selection.');
            const [runner] = await this.ds.query(`SELECT id FROM runner WHERE id = ? AND market_id = ?`, [p.winnerRunnerId, p.marketId]);
            if (!runner)
                throw new BetError('That selection is not in this market.');
        }
        const commissionPct = new decimal_js_1.default(market.commission_pct ?? 0);
        const bets = await this.ds.query(`SELECT * FROM sport_bet WHERE market_id = ? AND status = 'open'`, [p.marketId]);
        let won = 0, lost = 0, paid = new decimal_js_1.default(0);
        await this.ledger.inTx(async (qr) => {
            for (const bet of bets) {
                const winning = fancy
                    ? isFancyWin(bet.side, new decimal_js_1.default(bet.odds), value)
                    : isOddsWin(bet.side, bet.runner_id === p.winnerRunnerId);
                if (winning) {
                    const profit = new decimal_js_1.default(bet.potential_profit);
                    const commission = commissionPct.gt(0) ? profit.mul(commissionPct).div(100) : new decimal_js_1.default(0);
                    const payout = new decimal_js_1.default(bet.liability).plus(profit).minus(commission);
                    await this.ledger.move(qr, {
                        userId: bet.user_id, currency: bet.currency, delta: payout,
                        reference: `sb:stl:${bet.id}`,
                        meta: { betId: bet.id, marketId: p.marketId, result: 'won' },
                    });
                    await this.markSettled(qr, bet.id, 'won', payout, commission, p.adminId);
                    won++;
                    paid = paid.plus(payout);
                }
                else {
                    // The liability was taken at placement, so a loss moves no money.
                    await this.markSettled(qr, bet.id, 'lost', new decimal_js_1.default(0), new decimal_js_1.default(0), p.adminId);
                    lost++;
                }
            }
            if (!fancy) {
                await qr.query(`UPDATE runner SET status = CASE WHEN id = ? THEN 'winner' ELSE 'loser' END
                         WHERE market_id = ?`, [p.winnerRunnerId, p.marketId]);
            }
            await qr.query(`UPDATE market SET status='settled', settled_runner_id=?, settled_value=?, settled_at=NOW(), settled_by=?
          WHERE id = ?`, [p.winnerRunnerId ?? null, value ? value.toFixed(2) : null, p.adminId, p.marketId]);
            // When nothing is left open on the event, the event itself is done.
            const [openMarkets] = await qr.query(`SELECT COUNT(*) AS n FROM market WHERE event_id = ? AND status IN ('open','suspended','closed')`, [market.event_id]);
            if (Number(openMarkets.n) === 0) {
                await qr.query(`UPDATE sport_event SET status='settled' WHERE id = ?`, [market.event_id]);
            }
        });
        this.log.log(`market ${p.marketId} settled: ${won} won, ${lost} lost, paid ${paid.toFixed(2)}`);
        return { marketId: p.marketId, won, lost, paid: paid.toFixed(2) };
    }
    /** Void a market: every open bet has its liability returned in full. */
    async voidMarket(p) {
        const bets = await this.ds.query(`SELECT * FROM sport_bet WHERE market_id = ? AND status = 'open'`, [p.marketId]);
        let refunded = new decimal_js_1.default(0);
        await this.ledger.inTx(async (qr) => {
            for (const bet of bets) {
                const back = new decimal_js_1.default(bet.liability);
                await this.ledger.move(qr, {
                    userId: bet.user_id, currency: bet.currency, delta: back,
                    reference: `sb:void:${bet.id}`,
                    meta: { betId: bet.id, marketId: p.marketId, reason: p.reason ?? null },
                });
                await this.markSettled(qr, bet.id, 'void', back, new decimal_js_1.default(0), p.adminId, 'void');
                refunded = refunded.plus(back);
            }
            await qr.query(`UPDATE market SET status='voided', settled_at=NOW(), settled_by=? WHERE id = ?`, [p.adminId, p.marketId]);
        });
        return { marketId: p.marketId, bets: bets.length, refunded: refunded.toFixed(2) };
    }
    /** Void a single bet, for example one placed on an obviously wrong price. */
    async voidBet(p) {
        const [bet] = await this.ds.query(`SELECT * FROM sport_bet WHERE id = ?`, [p.betId]);
        if (!bet)
            throw new BetError('No such bet.');
        if (bet.status !== 'open')
            throw new BetError('That bet is already settled.');
        const back = new decimal_js_1.default(bet.liability);
        await this.ledger.inTx(async (qr) => {
            await this.ledger.move(qr, {
                userId: bet.user_id, currency: bet.currency, delta: back,
                reference: `sb:void:${bet.id}`,
                meta: { betId: bet.id, reason: p.reason ?? null },
            });
            await this.markSettled(qr, bet.id, 'void', back, new decimal_js_1.default(0), p.adminId, 'void');
        });
        return { betId: p.betId, refunded: back.toFixed(2) };
    }
    async markSettled(qr, betId, result, payout, commission, adminId, status = 'settled') {
        const res = await qr.query(`UPDATE sport_bet SET status=?, result=?, payout=?, commission=?, settled_at=NOW(), settled_by=?
        WHERE id = ? AND status = 'open'`, [status, result, payout.toFixed(2), commission.toFixed(2), adminId, betId]);
        // Second hard guard against double payment: an audit row keyed unique on
        // bet_id. If the table exists (Stage 1 migration) and a row is already there,
        // INSERT IGNORE simply does nothing. Wrapped so older DBs without the table
        // still settle normally.
        if (res.affectedRows) {
            await qr.query(`INSERT IGNORE INTO settlement (bet_id, event_id, market_id, result, stake, odds, payout)
         SELECT b.id, m.event_id, b.market_id, ?, b.stake, b.odds, ?
           FROM sport_bet b JOIN market m ON m.id = b.market_id WHERE b.id = ?`, [result, payout.toFixed(2), betId]).catch(() => { });
        }
    }
    /** Open liability per player, used by the player app and the risk screen. */
    async exposureOf(userId) {
        const [row] = await this.ds.query(`SELECT COALESCE(SUM(liability),0) AS liability, COUNT(*) AS bets
         FROM sport_bet WHERE user_id = ? AND status = 'open'`, [userId]);
        return { liability: Number(row.liability).toFixed(2), openBets: Number(row.bets) };
    }
};
exports.SportsService = SportsService;
exports.SportsService = SportsService = SportsService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [typeorm_1.DataSource,
        ledger_service_1.LedgerService])
], SportsService);
function isOddsWin(side, onWinner) {
    return side === 'back' ? onWinner : !onWinner;
}
/** Yes wins when the real figure reaches the line; no wins when it falls short. */
function isFancyWin(side, line, actual) {
    const reached = actual.gte(line);
    return side === 'yes' ? reached : !reached;
}
