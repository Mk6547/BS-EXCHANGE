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
exports.AdminWheelController = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("typeorm");
const node_crypto_1 = require("node:crypto");
const jwt_auth_guard_1 = require("../auth/jwt-auth.guard");
const agent_guards_1 = require("../agents/agent.guards");
const audit_service_1 = require("../platform/audit.service");
const wheel_service_1 = require("./wheel.service");
/** Wheel administration: items, payout maths, rounds and player bets. */
let AdminWheelController = class AdminWheelController {
    ds;
    wheel;
    audit;
    constructor(ds, wheel, audit) {
        this.ds = ds;
        this.wheel = wheel;
        this.audit = audit;
    }
    /** Items with the odds they actually produce, so the edge is never a guess. */
    async items() {
        const items = await this.ds.query(`SELECT id, name, icon, color, multiplier, slots, enabled, sort_order
         FROM wheel_item ORDER BY sort_order, name`);
        const live = items.filter((i) => i.enabled);
        const maths = wheel_service_1.WheelService.rtpOf(live);
        const houseEdge = live.length
            ? +(100 - maths.reduce((s, m) => s + m.rtpPct, 0) / live.length).toFixed(2)
            : 0;
        return { items, maths, averageRtpPct: +(100 - houseEdge).toFixed(2), houseEdgePct: houseEdge };
    }
    async createItem(req, b) {
        const id = b.id || (0, node_crypto_1.randomUUID)();
        if (!b?.name)
            throw new common_1.BadRequestException({ message: 'Give the item a name.' });
        await this.ds.query(`INSERT INTO wheel_item (id, name, icon, color, multiplier, slots, enabled, sort_order)
       VALUES (?,?,?,?,?,?,?,?)`, [id, b.name, b.icon ?? null, b.color ?? null, b.multiplier ?? 2, b.slots ?? 1,
            b.enabled === false ? 0 : 1, b.sortOrder ?? 0]);
        await this.audit.record({ adminId: req.user.id, action: 'wheel.item.create', target: id, metadata: b });
        return { id };
    }
    async updateItem(req, id, b) {
        const fields = [];
        const args = [];
        const set = (col, v) => { fields.push(`${col} = ?`); args.push(v); };
        if (b.name !== undefined)
            set('name', b.name);
        if (b.icon !== undefined)
            set('icon', b.icon);
        if (b.color !== undefined)
            set('color', b.color);
        if (b.multiplier !== undefined)
            set('multiplier', b.multiplier);
        if (b.slots !== undefined)
            set('slots', Math.max(1, Number(b.slots) || 1));
        if (b.enabled !== undefined)
            set('enabled', b.enabled ? 1 : 0);
        if (b.sortOrder !== undefined)
            set('sort_order', b.sortOrder);
        if (!fields.length)
            throw new common_1.BadRequestException({ message: 'Nothing to change.' });
        await this.ds.query(`UPDATE wheel_item SET ${fields.join(', ')} WHERE id = ?`, [...args, id]);
        await this.audit.record({ adminId: req.user.id, action: 'wheel.item.update', target: id, metadata: b });
        return { id };
    }
    async disableItem(req, id) {
        await this.ds.query(`UPDATE wheel_item SET enabled = 0 WHERE id = ?`, [id]);
        await this.audit.record({ adminId: req.user.id, action: 'wheel.item.disable', target: id });
        return { id, enabled: false };
    }
    async settings() {
        return this.wheel.config();
    }
    async saveSettings(req, body) {
        const allowed = ['enabled', 'round_seconds', 'min_stake', 'max_stake_per_item', 'max_items_per_round'];
        const changed = [];
        for (const [key, value] of Object.entries(body ?? {})) {
            if (!allowed.includes(key))
                continue;
            await this.ds.query(`INSERT INTO wheel_config (key_name, value) VALUES (?,?) ON DUPLICATE KEY UPDATE value = VALUES(value)`, [key, String(value ?? '').slice(0, 64)]);
            changed.push(key);
        }
        await this.audit.record({ adminId: req.user.id, action: 'wheel.settings.update', metadata: { changed } });
        return { changed };
    }
    /** Rounds with their seeds, so any result can be rechecked. */
    async rounds(limit) {
        const rows = await this.ds.query(`SELECT r.round_no, r.status, r.staked, r.paid, r.winning_slot, r.total_slots,
              r.server_seed, r.server_seed_hash, r.opened_at, r.settled_at, i.name AS winner
         FROM wheel_round r LEFT JOIN wheel_item i ON i.id = r.winning_item_id
        ORDER BY r.round_no DESC LIMIT ?`, [Math.min(Math.max(Number(limit ?? 50), 1), 200)]);
        const [totals] = await this.ds.query(`SELECT COALESCE(SUM(staked),0) AS staked, COALESCE(SUM(paid),0) AS paid, COUNT(*) AS rounds
         FROM wheel_round WHERE status = 'settled' AND settled_at > DATE_SUB(NOW(), INTERVAL 30 DAY)`);
        const staked = Number(totals.staked);
        const paid = Number(totals.paid);
        return {
            rounds: rows,
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
        if (q.status) {
            where.push('b.status = ?');
            args.push(q.status);
        }
        if (q.userId) {
            where.push('b.user_id = ?');
            args.push(q.userId);
        }
        const rows = await this.ds.query(`SELECT b.*, r.round_no, u.nickname FROM wheel_bet b
         JOIN wheel_round r ON r.id = b.round_id
         LEFT JOIN users u ON u.id = b.user_id
        WHERE ${where.join(' AND ')} ORDER BY b.placed_at DESC LIMIT ?`, [...args, Math.min(Math.max(Number(q.limit ?? 100), 1), 500)]);
        return { bets: rows };
    }
};
exports.AdminWheelController = AdminWheelController;
__decorate([
    (0, common_1.Get)('items'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], AdminWheelController.prototype, "items", null);
__decorate([
    (0, common_1.Post)('items'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], AdminWheelController.prototype, "createItem", null);
__decorate([
    (0, common_1.Put)('items/:id'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Param)('id')),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", Promise)
], AdminWheelController.prototype, "updateItem", null);
__decorate([
    (0, common_1.Delete)('items/:id'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], AdminWheelController.prototype, "disableItem", null);
__decorate([
    (0, common_1.Get)('settings'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], AdminWheelController.prototype, "settings", null);
__decorate([
    (0, common_1.Put)('settings'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], AdminWheelController.prototype, "saveSettings", null);
__decorate([
    (0, common_1.Get)('rounds'),
    __param(0, (0, common_1.Query)('limit')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], AdminWheelController.prototype, "rounds", null);
__decorate([
    (0, common_1.Get)('bets'),
    __param(0, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], AdminWheelController.prototype, "bets", null);
exports.AdminWheelController = AdminWheelController = __decorate([
    (0, common_1.Controller)('admin/wheel'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard, jwt_auth_guard_1.AdminGuard, agent_guards_1.MasterGuard),
    __metadata("design:paramtypes", [typeorm_1.DataSource,
        wheel_service_1.WheelService,
        audit_service_1.AuditService])
], AdminWheelController);
