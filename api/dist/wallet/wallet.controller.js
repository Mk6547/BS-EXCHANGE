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
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WalletController = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("typeorm");
const jwt_auth_guard_1 = require("../auth/jwt-auth.guard");
/**
 * Read-only wallet views for the player's own account.
 *
 * Every query is scoped by req.user.id from the verified token — never by an id
 * in the query string — so one player cannot read another's history.
 */
let WalletController = class WalletController {
    ds;
    constructor(ds) {
        this.ds = ds;
    }
    async summary(req) {
        const [wallet] = await this.ds.query(`SELECT w.balance, w.currency, w.status
         FROM wallet w JOIN users u ON u.id = w.user_id AND u.currency = w.currency
        WHERE w.user_id = ?`, [req.user.id]);
        const [totals] = await this.ds.query(`SELECT
         COUNT(*)                                        AS rounds,
         COALESCE(SUM(CASE WHEN action = 'bet' AND applied = 1 THEN amount END), 0)    AS staked,
         COALESCE(SUM(CASE WHEN action = 'withdraw' AND applied = 1 THEN result END), 0) AS won
       FROM inout_transaction WHERE user_id = ? AND action IN ('bet','withdraw')`, [req.user.id]);
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
    async history(req, q) {
        const limit = Math.min(Math.max(Number(q.limit ?? 25), 1), 100);
        const page = Math.max(Number(q.page ?? 1), 1);
        const offset = (page - 1) * limit;
        const rows = await this.ds.query(`SELECT id, delta, balance_after, reference, currency, created_at
         FROM wallet_ledger
        WHERE user_id = ?
        ORDER BY id DESC
        LIMIT ? OFFSET ?`, [req.user.id, limit, offset]);
        const [count] = await this.ds.query(`SELECT COUNT(*) AS n FROM wallet_ledger WHERE user_id = ?`, [req.user.id]);
        return {
            page,
            limit,
            total: Number(count.n),
            entries: rows.map((r) => ({
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
    async rounds(req, q) {
        const limit = Math.min(Math.max(Number(q.limit ?? 25), 1), 100);
        const rows = await this.ds.query(`SELECT game_mode, action, amount, result, coefficient, balance_after, created_at
         FROM inout_transaction
        WHERE user_id = ? AND action IN ('bet','withdraw')
        ORDER BY id DESC LIMIT ?`, [req.user.id, limit]);
        return {
            rounds: rows.map((r) => ({
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
};
exports.WalletController = WalletController;
__decorate([
    (0, common_1.Get)('summary'),
    __param(0, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], WalletController.prototype, "summary", null);
__decorate([
    (0, common_1.Get)('history'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], WalletController.prototype, "history", null);
__decorate([
    (0, common_1.Get)('rounds'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], WalletController.prototype, "rounds", null);
exports.WalletController = WalletController = __decorate([
    (0, common_1.Controller)('wallet'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    __metadata("design:paramtypes", [typeorm_1.DataSource])
], WalletController);
