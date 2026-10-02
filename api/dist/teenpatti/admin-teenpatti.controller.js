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
exports.AdminTeenPattiController = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("typeorm");
const jwt_auth_guard_1 = require("../auth/jwt-auth.guard");
const agent_guards_1 = require("../agents/agent.guards");
const audit_service_1 = require("../platform/audit.service");
const teenpatti_service_1 = require("./teenpatti.service");
/**
 * Teen Patti administration: odds, Pair Plus payouts, rounds and bets.
 *
 * The odds figure is where the margin lives. Both hands are equally likely, so
 * a fair price would be 2.00; anything below it is your edge.
 */
let AdminTeenPattiController = class AdminTeenPattiController {
    ds;
    tp;
    audit;
    constructor(ds, tp, audit) {
        this.ds = ds;
        this.tp = tp;
        this.audit = audit;
    }
    async settings() {
        const cfg = await this.tp.config();
        const payouts = await this.tp.payouts();
        const backOdds = Number(cfg.match_back_odds ?? 1.95);
        // Chance of each hand in three cards, from the 22,100 possible combinations.
        const chances = {
            pair: 16.94, flush: 4.96, straight: 3.26, trail: 0.24, straightflush: 0.22,
        };
        const pairPlusRtp = payouts.reduce((sum, p) => sum + ((chances[p.hand_rank] ?? 0) / 100) * (1 + Number(p.payout)), 0);
        return {
            config: cfg,
            payouts,
            maths: {
                // Ties are rare and refunded, so match odds are close to an even bet.
                matchRtpPct: +(backOdds / 2 * 100).toFixed(2),
                matchEdgePct: +(100 - (backOdds / 2 * 100)).toFixed(2),
                pairPlusRtpPct: +(pairPlusRtp * 100).toFixed(2),
                pairPlusEdgePct: +(100 - pairPlusRtp * 100).toFixed(2),
                chances,
            },
        };
    }
    async saveSettings(req, body) {
        const allowed = ['enabled', 'round_seconds', 'min_stake', 'max_stake',
            'match_back_odds', 'match_lay_odds', 'pairplus_enabled'];
        const changed = [];
        for (const [key, value] of Object.entries(body ?? {})) {
            if (!allowed.includes(key))
                continue;
            await this.ds.query(`INSERT INTO tp_config (key_name, value) VALUES (?,?) ON DUPLICATE KEY UPDATE value = VALUES(value)`, [key, String(value ?? '').slice(0, 64)]);
            changed.push(key);
        }
        await this.audit.record({ adminId: req.user.id, action: 'teenpatti.settings.update', metadata: { changed } });
        return { changed };
    }
    async savePayouts(req, body) {
        if (!Array.isArray(body?.payouts))
            throw new common_1.BadRequestException({ message: 'Nothing to change.' });
        for (const p of body.payouts) {
            await this.ds.query(`UPDATE tp_payout SET payout = ? WHERE hand_rank = ?`, [p.payout, p.rank]);
        }
        await this.audit.record({ adminId: req.user.id, action: 'teenpatti.payouts.update', metadata: body });
        return { ok: true };
    }
    async rounds(limit) {
        const rounds = await this.ds.query(`SELECT round_no, status, hand_a, hand_b, rank_a, rank_b, winner, staked, paid,
              server_seed, server_seed_hash, opened_at, settled_at
         FROM tp_round ORDER BY round_no DESC LIMIT ?`, [Math.min(Math.max(Number(limit ?? 50), 1), 200)]);
        const [totals] = await this.ds.query(`SELECT COUNT(*) AS rounds, COALESCE(SUM(staked),0) AS staked, COALESCE(SUM(paid),0) AS paid
         FROM tp_round WHERE status='settled' AND settled_at > DATE_SUB(NOW(), INTERVAL 30 DAY)`);
        const staked = Number(totals.staked);
        const paid = Number(totals.paid);
        return {
            rounds,
            last30Days: {
                rounds: Number(totals.rounds),
                staked: staked.toFixed(2),
                paid: paid.toFixed(2),
                margin: (staked - paid).toFixed(2),
                actualRtpPct: staked > 0 ? +((paid / staked) * 100).toFixed(2) : null,
            },
        };
    }
    async bets(q) {
        const where = ['1=1'];
        const args = [];
        if (q.market) {
            where.push('b.market = ?');
            args.push(q.market);
        }
        if (q.result) {
            where.push('b.result = ?');
            args.push(q.result);
        }
        const rows = await this.ds.query(`SELECT b.*, r.round_no, r.winner, u.nickname FROM tp_bet b
         JOIN tp_round r ON r.id = b.round_id
         LEFT JOIN users u ON u.id = b.user_id
        WHERE ${where.join(' AND ')} ORDER BY b.placed_at DESC LIMIT ?`, [...args, Math.min(Math.max(Number(q.limit ?? 100), 1), 500)]);
        return { bets: rows };
    }
};
exports.AdminTeenPattiController = AdminTeenPattiController;
__decorate([
    (0, common_1.Get)('settings'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], AdminTeenPattiController.prototype, "settings", null);
__decorate([
    (0, common_1.Put)('settings'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], AdminTeenPattiController.prototype, "saveSettings", null);
__decorate([
    (0, common_1.Put)('payouts'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], AdminTeenPattiController.prototype, "savePayouts", null);
__decorate([
    (0, common_1.Get)('rounds'),
    __param(0, (0, common_1.Query)('limit')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], AdminTeenPattiController.prototype, "rounds", null);
__decorate([
    (0, common_1.Get)('bets'),
    __param(0, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], AdminTeenPattiController.prototype, "bets", null);
exports.AdminTeenPattiController = AdminTeenPattiController = __decorate([
    (0, common_1.Controller)('admin/teenpatti'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard, jwt_auth_guard_1.AdminGuard, agent_guards_1.MasterGuard),
    __metadata("design:paramtypes", [typeorm_1.DataSource,
        teenpatti_service_1.TeenPattiService,
        audit_service_1.AuditService])
], AdminTeenPattiController);
