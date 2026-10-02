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
exports.AgentController = void 0;
const common_1 = require("@nestjs/common");
const jwt_auth_guard_1 = require("../auth/jwt-auth.guard");
const audit_service_1 = require("../platform/audit.service");
const agent_service_1 = require("./agent.service");
const winloss_sync_service_1 = require("./winloss-sync.service");
const agent_guards_1 = require("./agent.guards");
/**
 * Master and admin management.
 *
 * Master-only routes create and fund admins. Shared routes (players, sheets)
 * are scoped inside by role: an admin sees only their own, the master sees all.
 */
let AgentController = class AgentController {
    agents;
    sync;
    audit;
    constructor(agents, sync, audit) {
        this.agents = agents;
        this.sync = sync;
        this.audit = audit;
    }
    /** Who am I — the panel uses this to decide what to show. */
    async me(req) {
        const u = await this.agents.userRow(req.user.id);
        return {
            id: u.id, nickname: u.nickname, role: u.role,
            commissionPct: Number(u.commission_pct).toFixed(1),
            floatLimit: Number(u.float_limit).toFixed(2),
            floatUsed: Number(u.float_used).toFixed(2),
            floatLeft: (Number(u.float_limit) - Number(u.float_used)).toFixed(2),
        };
    }
    categories() {
        return this.agents.categories().then((categories) => ({ categories }));
    }
    async getMaxBets(id) {
        return { maxBets: await this.agents.getMaxBets(id) };
    }
    async setMaxBets(req, id, b) {
        try {
            const out = await this.agents.setMaxBets({
                actorId: req.user.id, actorRole: req.user.role, targetId: id, maxBets: b?.maxBets || {},
            });
            await this.audit.record({ adminId: req.user.id, action: 'agent.maxbets.set', target: id });
            return out;
        }
        catch (e) {
            throw wrap(e);
        }
    }
    // ---------------------------------------------------------- admins (master)
    admins() {
        return this.agents.listAdmins().then((admins) => ({ admins }));
    }
    async createAdmin(req, b) {
        try {
            const out = await this.agents.createAdmin({
                nickname: b?.nickname, password: b?.password, commissionPct: b?.commissionPct, masterId: req.user.id, maxBets: b?.maxBets,
            });
            await this.audit.record({ adminId: req.user.id, action: 'agent.admin.create', target: out.id, metadata: { nickname: out.nickname } });
            return out;
        }
        catch (e) {
            throw wrap(e);
        }
    }
    async updateAdmin(req, id, b) {
        try {
            const out = await this.agents.updateAdmin(id, { commissionPct: b?.commissionPct, status: b?.status });
            await this.audit.record({ adminId: req.user.id, action: 'agent.admin.update', target: id, metadata: b });
            return out;
        }
        catch (e) {
            throw wrap(e);
        }
    }
    async setAdminPassword(req, id, b) {
        try {
            const out = await this.agents.setAdminPassword(id, String(b?.password ?? ''));
            await this.audit.record({ adminId: req.user.id, action: 'agent.admin.password', target: id });
            return out;
        }
        catch (e) {
            throw wrap(e);
        }
    }
    async deleteAdmin(req, id) {
        try {
            const out = await this.agents.deleteAdmin(id, req.user.id);
            await this.audit.record({ adminId: req.user.id, action: 'agent.admin.delete', target: id, metadata: out });
            return out;
        }
        catch (e) {
            throw wrap(e);
        }
    }
    async fund(req, id, b) {
        try {
            const out = await this.agents.fundAdmin({
                masterId: req.user.id, adminId: id, kind: b?.kind, amount: String(b?.amount ?? ''), note: b?.note,
            });
            await this.audit.record({ adminId: req.user.id, action: 'agent.admin.fund', target: id, metadata: { kind: b?.kind, amount: b?.amount } });
            return out;
        }
        catch (e) {
            throw wrap(e);
        }
    }
    /** Master's oversight of one admin: float record + win/loss sheet. */
    async adminSheet(id, q) {
        await this.sync.tick();
        const [floatSheet, winloss, players] = await Promise.all([
            this.agents.floatSheet(id),
            this.agents.winlossSheet(id, q.from, q.to),
            this.agents.listPlayers(id),
        ]);
        return { floatSheet, winloss, players };
    }
    // ------------------------------------------------------------ mini admins
    async minis(req, q) {
        if (req.user.role === 'master')
            return { minis: await this.agents.allMinis() };
        if (req.user.role === 'admin')
            return { minis: await this.agents.listMinis(req.user.id) };
        return { minis: [] }; // a mini admin has none
    }
    async createMini(req, b) {
        if (req.user.role !== 'admin')
            throw new common_1.BadRequestException({ message: 'Only an admin can create a mini admin.' });
        try {
            const out = await this.agents.createMini({ adminId: req.user.id, nickname: b?.nickname, password: b?.password, sharePct: b?.sharePct });
            await this.audit.record({ adminId: req.user.id, action: 'agent.mini.create', target: out.id, metadata: { nickname: out.nickname, sharePct: b?.sharePct } });
            return out;
        }
        catch (e) {
            throw wrap(e);
        }
    }
    async updateMini(req, id, b) {
        if (req.user.role !== 'admin')
            throw new common_1.BadRequestException({ message: 'Only the owning admin can edit a mini admin.' });
        try {
            const out = await this.agents.updateMini({ adminId: req.user.id, miniId: id, sharePct: b?.sharePct, status: b?.status, password: b?.password });
            await this.audit.record({ adminId: req.user.id, action: 'agent.mini.update', target: id, metadata: b });
            return out;
        }
        catch (e) {
            throw wrap(e);
        }
    }
    async deleteMini(req, id) {
        if (req.user.role !== 'admin')
            throw new common_1.BadRequestException({ message: 'Only the owning admin can delete a mini admin.' });
        try {
            const out = await this.agents.deleteMini({ adminId: req.user.id, miniId: id });
            await this.audit.record({ adminId: req.user.id, action: 'agent.mini.delete', target: id, metadata: out });
            return out;
        }
        catch (e) {
            throw wrap(e);
        }
    }
    async fundMini(req, id, b) {
        if (req.user.role !== 'admin')
            throw new common_1.BadRequestException({ message: 'Only the owning admin can fund a mini admin.' });
        try {
            const out = await this.agents.fundMini({ adminId: req.user.id, miniId: id, kind: b?.kind, amount: String(b?.amount ?? ''), note: b?.note });
            await this.audit.record({ adminId: req.user.id, action: 'agent.mini.fund', target: id, metadata: { kind: b?.kind, amount: b?.amount } });
            return out;
        }
        catch (e) {
            throw wrap(e);
        }
    }
    // ---------------------------------------------------------- players (both)
    async players(req, q) {
        // Master may pass all=1 to see everyone; an admin is always scoped to own.
        const all = req.user.role === 'master' && q.all === '1';
        const ownerId = req.user.role === 'master' && q.owner ? q.owner : req.user.id;
        const players = await this.agents.listPlayers(ownerId, { search: q.search, all });
        return { players };
    }
    async createPlayer(req, b) {
        try {
            const out = await this.agents.createPlayer({ ownerId: req.user.id, nickname: b?.nickname, password: b?.password, maxBets: b?.maxBets });
            await this.audit.record({ adminId: req.user.id, action: 'agent.player.create', target: out.id, metadata: { nickname: out.nickname } });
            return out;
        }
        catch (e) {
            throw wrap(e);
        }
    }
    async adjustPlayer(req, id, b) {
        try {
            const out = await this.agents.adjustPlayer({
                actorId: req.user.id, actorRole: req.user.role, playerId: id, delta: String(b?.delta ?? ''), note: b?.note,
            });
            await this.audit.record({ adminId: req.user.id, action: 'agent.player.adjust', target: id, metadata: { delta: b?.delta } });
            return out;
        }
        catch (e) {
            throw wrap(e);
        }
    }
    async playerDetail(req, id) {
        try {
            return await this.agents.playerDetail({ actorId: req.user.id, actorRole: req.user.role, playerId: id });
        }
        catch (e) {
            throw wrap(e);
        }
    }
    async setPlayerPassword(req, id, b) {
        try {
            const out = await this.agents.setPlayerPassword({ actorId: req.user.id, actorRole: req.user.role, playerId: id, password: String(b?.password ?? '') });
            await this.audit.record({ adminId: req.user.id, action: 'agent.player.password', target: id });
            return out;
        }
        catch (e) {
            throw wrap(e);
        }
    }
    async setPlayerStatus(req, id, b) {
        try {
            const out = await this.agents.setPlayerStatus({ actorId: req.user.id, actorRole: req.user.role, playerId: id, status: b?.status });
            await this.audit.record({ adminId: req.user.id, action: 'agent.player.status', target: id, metadata: { status: b?.status } });
            return out;
        }
        catch (e) {
            throw wrap(e);
        }
    }
    async deletePlayer(req, id) {
        try {
            const out = await this.agents.deletePlayer({ actorId: req.user.id, actorRole: req.user.role, playerId: id });
            await this.audit.record({ adminId: req.user.id, action: 'agent.player.delete', target: id });
            return out;
        }
        catch (e) {
            throw wrap(e);
        }
    }
    // ------------------------------------------------------ sports (per-owner)
    async sports(req) {
        // master uses the full Sports events screen; this is for admin/mini.
        if (req.user.role === 'master')
            return { events: [] };
        return { events: await this.agents.ownerSportsList(req.user.id) };
    }
    async suspendSport(req, eventId, b) {
        if (req.user.role === 'master')
            throw new common_1.BadRequestException({ message: 'Use the main Sports events screen.' });
        const out = await this.agents.setOwnerSuspend({ ownerId: req.user.id, eventId, suspend: !!b?.suspend });
        await this.audit.record({ adminId: req.user.id, action: 'agent.sport.suspend', target: eventId, metadata: { suspend: !!b?.suspend } });
        return out;
    }
    // --------------------------------------------------------- account ledger
    async ledgerAccounts(req, q) {
        return this.agents.ledgerAccounts({ viewerId: req.user.id, viewerRole: req.user.role, viewAs: q.viewAs });
    }
    async ledger(req, q) {
        return this.agents.accountLedger({
            viewerId: req.user.id, viewerRole: req.user.role, viewAs: q.viewAs,
            account: q.account || '_transactions', from: q.from, to: q.to,
        });
    }
    // ------------------------------------------------------------- own sheets
    /** An admin's own win/loss sheet; the master gets the same via /admins/:id/sheet. */
    async winloss(req, q) {
        await this.sync.tick();
        // master may view any admin/mini; staff view their own, scoped by role.
        const staffId = req.user.role === 'master' && q.admin ? q.admin : req.user.id;
        const role = req.user.role === 'master' ? (q.role || 'admin') : req.user.role;
        return this.agents.winlossSheet(staffId, q.from, q.to, role);
    }
    async float(req, q) {
        const adminId = req.user.role === 'master' && q.admin ? q.admin : req.user.id;
        if (req.user.role === 'master' && !q.admin)
            return { floatLimit: '—', floatUsed: '—', floatLeft: '—', commissionPct: '—', funding: [] };
        return this.agents.floatSheet(adminId);
    }
};
exports.AgentController = AgentController;
__decorate([
    (0, common_1.Get)('me'),
    __param(0, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], AgentController.prototype, "me", null);
__decorate([
    (0, common_1.Get)('categories'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], AgentController.prototype, "categories", null);
__decorate([
    (0, common_1.Get)('max-bets/:id'),
    __param(0, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], AgentController.prototype, "getMaxBets", null);
__decorate([
    (0, common_1.Put)('max-bets/:id'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Param)('id')),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", Promise)
], AgentController.prototype, "setMaxBets", null);
__decorate([
    (0, common_1.Get)('admins'),
    (0, common_1.UseGuards)(agent_guards_1.MasterGuard),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], AgentController.prototype, "admins", null);
__decorate([
    (0, common_1.Post)('admins'),
    (0, common_1.UseGuards)(agent_guards_1.MasterGuard),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], AgentController.prototype, "createAdmin", null);
__decorate([
    (0, common_1.Put)('admins/:id'),
    (0, common_1.UseGuards)(agent_guards_1.MasterGuard),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Param)('id')),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", Promise)
], AgentController.prototype, "updateAdmin", null);
__decorate([
    (0, common_1.Put)('admins/:id/password'),
    (0, common_1.UseGuards)(agent_guards_1.MasterGuard),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Param)('id')),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", Promise)
], AgentController.prototype, "setAdminPassword", null);
__decorate([
    (0, common_1.Delete)('admins/:id'),
    (0, common_1.UseGuards)(agent_guards_1.MasterGuard),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], AgentController.prototype, "deleteAdmin", null);
__decorate([
    (0, common_1.Post)('admins/:id/fund'),
    (0, common_1.UseGuards)(agent_guards_1.MasterGuard),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Param)('id')),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", Promise)
], AgentController.prototype, "fund", null);
__decorate([
    (0, common_1.Get)('admins/:id/sheet'),
    (0, common_1.UseGuards)(agent_guards_1.MasterGuard),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], AgentController.prototype, "adminSheet", null);
__decorate([
    (0, common_1.Get)('minis'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], AgentController.prototype, "minis", null);
__decorate([
    (0, common_1.Post)('minis'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], AgentController.prototype, "createMini", null);
__decorate([
    (0, common_1.Put)('minis/:id'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Param)('id')),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", Promise)
], AgentController.prototype, "updateMini", null);
__decorate([
    (0, common_1.Delete)('minis/:id'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], AgentController.prototype, "deleteMini", null);
__decorate([
    (0, common_1.Post)('minis/:id/fund'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Param)('id')),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", Promise)
], AgentController.prototype, "fundMini", null);
__decorate([
    (0, common_1.Get)('players'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], AgentController.prototype, "players", null);
__decorate([
    (0, common_1.Post)('players'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], AgentController.prototype, "createPlayer", null);
__decorate([
    (0, common_1.Post)('players/:id/adjust'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Param)('id')),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", Promise)
], AgentController.prototype, "adjustPlayer", null);
__decorate([
    (0, common_1.Get)('players/:id/detail'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], AgentController.prototype, "playerDetail", null);
__decorate([
    (0, common_1.Put)('players/:id/password'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Param)('id')),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", Promise)
], AgentController.prototype, "setPlayerPassword", null);
__decorate([
    (0, common_1.Put)('players/:id/status'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Param)('id')),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", Promise)
], AgentController.prototype, "setPlayerStatus", null);
__decorate([
    (0, common_1.Delete)('players/:id'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], AgentController.prototype, "deletePlayer", null);
__decorate([
    (0, common_1.Get)('sports'),
    __param(0, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], AgentController.prototype, "sports", null);
__decorate([
    (0, common_1.Post)('sports/:eventId/suspend'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Param)('eventId')),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", Promise)
], AgentController.prototype, "suspendSport", null);
__decorate([
    (0, common_1.Get)('ledger/accounts'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], AgentController.prototype, "ledgerAccounts", null);
__decorate([
    (0, common_1.Get)('ledger'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], AgentController.prototype, "ledger", null);
__decorate([
    (0, common_1.Get)('winloss'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], AgentController.prototype, "winloss", null);
__decorate([
    (0, common_1.Get)('float'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], AgentController.prototype, "float", null);
exports.AgentController = AgentController = __decorate([
    (0, common_1.Controller)('staff'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard, agent_guards_1.StaffGuard),
    __metadata("design:paramtypes", [agent_service_1.AgentService,
        winloss_sync_service_1.WinlossSyncService,
        audit_service_1.AuditService])
], AgentController);
function wrap(e) {
    if (e instanceof agent_service_1.AgentError)
        return new common_1.BadRequestException({ message: e.message });
    return new common_1.BadRequestException({ message: e?.message ?? 'Something went wrong.' });
}
