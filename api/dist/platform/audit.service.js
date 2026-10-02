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
var AuditService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuditService = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("typeorm");
/**
 * Every sensitive admin action is recorded here.
 *
 * Writes are best-effort and never block the action itself — a failed audit
 * write must not roll back an approved withdrawal — but failures are logged
 * loudly, because a silently empty audit trail is worse than no audit trail.
 */
let AuditService = AuditService_1 = class AuditService {
    ds;
    log = new common_1.Logger(AuditService_1.name);
    constructor(ds) {
        this.ds = ds;
    }
    async record(p) {
        try {
            await this.ds.query(`INSERT INTO admin_audit_log (admin_id, action, target, metadata, ip) VALUES (?, ?, ?, ?, ?)`, [p.adminId, p.action, p.target ?? null, JSON.stringify(p.metadata ?? {}), p.ip ?? null]);
        }
        catch (err) {
            this.log.error(`audit write failed for ${p.action}: ${err?.message}`);
        }
    }
};
exports.AuditService = AuditService;
exports.AuditService = AuditService = AuditService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [typeorm_1.DataSource])
], AuditService);
