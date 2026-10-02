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
exports.AdminSicBoController = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("typeorm");
const jwt_auth_guard_1 = require("../auth/jwt-auth.guard");
const agent_guards_1 = require("../agents/agent.guards");
const audit_service_1 = require("../platform/audit.service");
const sicbo_service_1 = require("./sicbo.service");
let AdminSicBoController = class AdminSicBoController {
    ds;
    sb;
    audit;
    constructor(ds, sb, audit) {
        this.ds = ds;
        this.sb = sb;
        this.audit = audit;
    }
    async settings() {
        const cfg = await this.sb.config();
        const payouts = await this.sb.payouts();
        // Exact chances from the 216 outcomes, for the live edge display.
        const rolls = [];
        for (let a = 1; a <= 6; a++)
            for (let b = 1; b <= 6; b++)
                for (let c = 1; c <= 6; c++)
                    rolls.push({ d1: a, d2: b, d3: c, total: a + b + c });
        const playerRtp = (m, s, rate) => {
            let sum = 0;
            for (const r of rolls) {
                const mult = sicbo_service_1.SicBoService.evaluate(m, s, rate, r);
                if (mult > 0)
                    sum += 1 + mult;
            }
            return sum / rolls.length;
        };
        return {
            config: cfg,
            payouts: payouts.map((p) => {
                const rtp = playerRtp(p.market, p.selection, Number(p.payout));
                return { ...p, rtpPct: +(rtp * 100).toFixed(1), edgePct: +((1 - rtp) * 100).toFixed(1) };
            }),
        };
    }
    async saveSettings(req, body) {
        const allowed = ['enabled', 'round_seconds', 'min_stake', 'max_stake', 'max_exposure_per_selection'];
        const changed = [];
        for (const [k, v] of Object.entries(body ?? {})) {
            if (!allowed.includes(k))
                continue;
            await this.ds.query(`INSERT INTO sb_config (key_name,value) VALUES (?,?) ON DUPLICATE KEY UPDATE value=VALUES(value)`, [k, String(v ?? '').slice(0, 64)]);
            changed.push(k);
        }
        await this.audit.record({ adminId: req.user.id, action: 'sicbo.settings.update', metadata: { changed } });
        return { changed };
    }
    async savePayouts(req, body) {
        if (!Array.isArray(body?.payouts))
            throw new common_1.BadRequestException({ message: 'Nothing to change.' });
        for (const p of body.payouts)
            await this.ds.query(`UPDATE sb_payout SET payout=? WHERE market=? AND selection=?`, [p.payout, p.market, p.selection]);
        await this.audit.record({ adminId: req.user.id, action: 'sicbo.payouts.update', metadata: body });
        return { ok: true };
    }
    async rounds(limit) {
        const rounds = await this.ds.query(`SELECT round_no, status, d1, d2, d3, total, staked, paid, settled_at FROM sb_round ORDER BY round_no DESC LIMIT ?`, [Math.min(Math.max(Number(limit ?? 50), 1), 200)]);
        const [t] = await this.ds.query(`SELECT COUNT(*) AS rounds, COALESCE(SUM(staked),0) AS staked, COALESCE(SUM(paid),0) AS paid
         FROM sb_round WHERE status='settled' AND settled_at > DATE_SUB(NOW(), INTERVAL 30 DAY)`);
        const staked = Number(t.staked), paid = Number(t.paid);
        return { rounds, last30Days: { rounds: Number(t.rounds), staked: staked.toFixed(2), paid: paid.toFixed(2), margin: (staked - paid).toFixed(2), actualRtpPct: staked > 0 ? +((paid / staked) * 100).toFixed(2) : null } };
    }
    async bets(q) {
        const where = ['1=1'];
        const args = [];
        if (q.market) {
            where.push('b.market=?');
            args.push(q.market);
        }
        const rows = await this.ds.query(`SELECT b.*, r.round_no, r.total AS roll_total, u.nickname FROM sb_bet b
         JOIN sb_round r ON r.id=b.round_id LEFT JOIN users u ON u.id=b.user_id
        WHERE ${where.join(' AND ')} ORDER BY b.placed_at DESC LIMIT ?`, [...args, Math.min(Math.max(Number(q.limit ?? 100), 1), 500)]);
        return { bets: rows };
    }
};
exports.AdminSicBoController = AdminSicBoController;
__decorate([
    (0, common_1.Get)('settings'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], AdminSicBoController.prototype, "settings", null);
__decorate([
    (0, common_1.Put)('settings'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], AdminSicBoController.prototype, "saveSettings", null);
__decorate([
    (0, common_1.Put)('payouts'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], AdminSicBoController.prototype, "savePayouts", null);
__decorate([
    (0, common_1.Get)('rounds'),
    __param(0, (0, common_1.Query)('limit')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], AdminSicBoController.prototype, "rounds", null);
__decorate([
    (0, common_1.Get)('bets'),
    __param(0, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], AdminSicBoController.prototype, "bets", null);
exports.AdminSicBoController = AdminSicBoController = __decorate([
    (0, common_1.Controller)('admin/sicbo'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard, jwt_auth_guard_1.AdminGuard, agent_guards_1.MasterGuard),
    __metadata("design:paramtypes", [typeorm_1.DataSource, sicbo_service_1.SicBoService, audit_service_1.AuditService])
], AdminSicBoController);
