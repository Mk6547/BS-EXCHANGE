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
exports.AdminConfigController = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("typeorm");
const node_crypto_1 = require("node:crypto");
const jwt_auth_guard_1 = require("../auth/jwt-auth.guard");
const audit_service_1 = require("./audit.service");
const content_controller_1 = require("./content.controller");
/**
 * Configuration the admin owns: payment methods, banners, promotions and site
 * settings. All of it is data, so adding a new payment method or promotion
 * never requires a code change or a deploy.
 */
let AdminConfigController = class AdminConfigController {
    ds;
    audit;
    constructor(ds, audit) {
        this.ds = ds;
        this.audit = audit;
    }
    // -------------------------------------------------------- payment methods
    async listMethods() {
        const rows = await this.ds.query(`SELECT * FROM payment_method ORDER BY sort_order, display_name`);
        return { methods: rows.map((r) => ({ ...r, required_fields: (0, content_controller_1.parseJson)(r.required_fields) ?? [] })) };
    }
    async createMethod(req, body) {
        const id = (0, node_crypto_1.randomUUID)();
        const v = methodValues(body);
        if (!v.code || !v.display_name) {
            throw new common_1.BadRequestException({ message: 'A code and display name are required.' });
        }
        await this.ds.query(`INSERT INTO payment_method
        (id, code, display_name, kind, logo_url, currency, enabled, supports_deposit, supports_withdrawal,
         min_deposit, max_deposit, min_withdrawal, max_withdrawal, deposit_fee_pct, withdrawal_fee_pct,
         instructions, pay_to_details, required_fields, sort_order)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id, v.code, v.display_name, v.kind, v.logo_url, v.currency, v.enabled, v.supports_deposit,
            v.supports_withdrawal, v.min_deposit, v.max_deposit, v.min_withdrawal, v.max_withdrawal,
            v.deposit_fee_pct, v.withdrawal_fee_pct, v.instructions, v.pay_to_details,
            JSON.stringify(v.required_fields), v.sort_order]);
        await this.audit.record({ adminId: req.user.id, action: 'method.create', target: v.code });
        return { id };
    }
    async updateMethod(req, id, body) {
        const v = methodValues(body);
        const res = await this.ds.query(`UPDATE payment_method SET display_name=?, kind=?, logo_url=?, currency=?, enabled=?,
         supports_deposit=?, supports_withdrawal=?, min_deposit=?, max_deposit=?, min_withdrawal=?,
         max_withdrawal=?, deposit_fee_pct=?, withdrawal_fee_pct=?, instructions=?, pay_to_details=?,
         required_fields=?, sort_order=?
       WHERE id = ?`, [v.display_name, v.kind, v.logo_url, v.currency, v.enabled, v.supports_deposit, v.supports_withdrawal,
            v.min_deposit, v.max_deposit, v.min_withdrawal, v.max_withdrawal, v.deposit_fee_pct,
            v.withdrawal_fee_pct, v.instructions, v.pay_to_details, JSON.stringify(v.required_fields),
            v.sort_order, id]);
        if (!res.affectedRows)
            throw new common_1.BadRequestException({ message: 'No such payment method.' });
        await this.audit.record({ adminId: req.user.id, action: 'method.update', target: id });
        return { id };
    }
    async disableMethod(req, id) {
        // Disabled rather than deleted: deposits and withdrawals reference it, and
        // history must stay readable.
        await this.ds.query(`UPDATE payment_method SET enabled = 0 WHERE id = ?`, [id]);
        await this.audit.record({ adminId: req.user.id, action: 'method.disable', target: id });
        return { id, enabled: false };
    }
    // ---------------------------------------------------------------- banners
    async listBanners() {
        return { banners: await this.ds.query(`SELECT * FROM banner ORDER BY sort_order, created_at`) };
    }
    async createBanner(req, b) {
        const id = (0, node_crypto_1.randomUUID)();
        await this.ds.query(`INSERT INTO banner (id, title, subtitle, image_url, mobile_image_url, cta_text, cta_link,
                           enabled, starts_at, ends_at, sort_order)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [id, str(b.title, 160), str(b.subtitle, 255), str(b.imageUrl, 512), str(b.mobileImageUrl, 512),
            str(b.ctaText, 64), str(b.ctaLink, 512), b.enabled === false ? 0 : 1,
            date(b.startsAt), date(b.endsAt), Number(b.sortOrder ?? 0)]);
        await this.audit.record({ adminId: req.user.id, action: 'banner.create', target: id });
        return { id };
    }
    async updateBanner(req, id, b) {
        await this.ds.query(`UPDATE banner SET title=?, subtitle=?, image_url=?, mobile_image_url=?, cta_text=?, cta_link=?,
         enabled=?, starts_at=?, ends_at=?, sort_order=? WHERE id=?`, [str(b.title, 160), str(b.subtitle, 255), str(b.imageUrl, 512), str(b.mobileImageUrl, 512),
            str(b.ctaText, 64), str(b.ctaLink, 512), b.enabled === false ? 0 : 1,
            date(b.startsAt), date(b.endsAt), Number(b.sortOrder ?? 0), id]);
        await this.audit.record({ adminId: req.user.id, action: 'banner.update', target: id });
        return { id };
    }
    async deleteBanner(req, id) {
        await this.ds.query(`DELETE FROM banner WHERE id = ?`, [id]);
        await this.audit.record({ adminId: req.user.id, action: 'banner.delete', target: id });
        return { id, deleted: true };
    }
    // ------------------------------------------------------------- promotions
    async listPromotions() {
        return { promotions: await this.ds.query(`SELECT * FROM promotion ORDER BY sort_order, created_at`) };
    }
    async createPromotion(req, p) {
        const id = (0, node_crypto_1.randomUUID)();
        const slug = String(p.slug ?? '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
        if (!slug || !p.title)
            throw new common_1.BadRequestException({ message: 'A slug and title are required.' });
        await this.ds.query(`INSERT INTO promotion (id, slug, title, summary, body, image_url, bonus_pct, min_deposit,
                              max_bonus, terms, enabled, starts_at, ends_at, sort_order)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id, slug, str(p.title, 160), str(p.summary, 255), p.body ?? null, str(p.imageUrl, 512),
            num(p.bonusPct), num(p.minDeposit), num(p.maxBonus), p.terms ?? null,
            p.enabled === false ? 0 : 1, date(p.startsAt), date(p.endsAt), Number(p.sortOrder ?? 0)]);
        await this.audit.record({ adminId: req.user.id, action: 'promotion.create', target: slug });
        return { id, slug };
    }
    async updatePromotion(req, id, p) {
        await this.ds.query(`UPDATE promotion SET title=?, summary=?, body=?, image_url=?, bonus_pct=?, min_deposit=?,
         max_bonus=?, terms=?, enabled=?, starts_at=?, ends_at=?, sort_order=? WHERE id=?`, [str(p.title, 160), str(p.summary, 255), p.body ?? null, str(p.imageUrl, 512),
            num(p.bonusPct), num(p.minDeposit), num(p.maxBonus), p.terms ?? null,
            p.enabled === false ? 0 : 1, date(p.startsAt), date(p.endsAt), Number(p.sortOrder ?? 0), id]);
        await this.audit.record({ adminId: req.user.id, action: 'promotion.update', target: id });
        return { id };
    }
    async deletePromotion(req, id) {
        await this.ds.query(`DELETE FROM promotion WHERE id = ?`, [id]);
        await this.audit.record({ adminId: req.user.id, action: 'promotion.delete', target: id });
        return { id, deleted: true };
    }
    // --------------------------------------------------------------- settings
    async settings() {
        const rows = await this.ds.query(`SELECT key_name, value FROM site_setting`);
        const out = {};
        for (const r of rows)
            out[r.key_name] = r.value;
        return out;
    }
    async updateSettings(req, body) {
        // Whitelisted, so a compromised admin session cannot write arbitrary keys
        // that some other part of the system might later read as configuration.
        const allowed = ['site_name', 'currency_display', 'support_whatsapp', 'support_telegram',
            'support_email', 'maintenance_mode', 'logo_url',
            'whatsapp_float_number', 'whatsapp_float_enabled'];
        const changed = [];
        for (const [key, value] of Object.entries(body ?? {})) {
            if (!allowed.includes(key))
                continue;
            await this.ds.query(`INSERT INTO site_setting (key_name, value) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE value = VALUES(value)`, [key, String(value ?? '').slice(0, 2000)]);
            changed.push(key);
        }
        await this.audit.record({ adminId: req.user.id, action: 'settings.update', metadata: { changed } });
        return { changed };
    }
};
exports.AdminConfigController = AdminConfigController;
__decorate([
    (0, common_1.Get)('payment-methods'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], AdminConfigController.prototype, "listMethods", null);
__decorate([
    (0, common_1.Post)('payment-methods'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], AdminConfigController.prototype, "createMethod", null);
__decorate([
    (0, common_1.Put)('payment-methods/:id'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Param)('id')),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", Promise)
], AdminConfigController.prototype, "updateMethod", null);
__decorate([
    (0, common_1.Delete)('payment-methods/:id'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], AdminConfigController.prototype, "disableMethod", null);
__decorate([
    (0, common_1.Get)('banners'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], AdminConfigController.prototype, "listBanners", null);
__decorate([
    (0, common_1.Post)('banners'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], AdminConfigController.prototype, "createBanner", null);
__decorate([
    (0, common_1.Put)('banners/:id'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Param)('id')),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", Promise)
], AdminConfigController.prototype, "updateBanner", null);
__decorate([
    (0, common_1.Delete)('banners/:id'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], AdminConfigController.prototype, "deleteBanner", null);
__decorate([
    (0, common_1.Get)('promotions'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], AdminConfigController.prototype, "listPromotions", null);
__decorate([
    (0, common_1.Post)('promotions'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], AdminConfigController.prototype, "createPromotion", null);
__decorate([
    (0, common_1.Put)('promotions/:id'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Param)('id')),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", Promise)
], AdminConfigController.prototype, "updatePromotion", null);
__decorate([
    (0, common_1.Delete)('promotions/:id'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], AdminConfigController.prototype, "deletePromotion", null);
__decorate([
    (0, common_1.Get)('settings'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], AdminConfigController.prototype, "settings", null);
__decorate([
    (0, common_1.Put)('settings'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], AdminConfigController.prototype, "updateSettings", null);
exports.AdminConfigController = AdminConfigController = __decorate([
    (0, common_1.Controller)('admin'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard, jwt_auth_guard_1.AdminGuard),
    __metadata("design:paramtypes", [typeorm_1.DataSource,
        audit_service_1.AuditService])
], AdminConfigController);
function methodValues(b) {
    return {
        code: String(b.code ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, ''),
        display_name: str(b.displayName, 96),
        kind: str(b.kind, 24) ?? 'manual',
        logo_url: str(b.logoUrl, 512),
        currency: str(b.currency, 16) ?? 'PKR',
        enabled: b.enabled === false ? 0 : 1,
        supports_deposit: b.supportsDeposit === false ? 0 : 1,
        supports_withdrawal: b.supportsWithdrawal ? 1 : 0,
        min_deposit: num(b.minDeposit) ?? 0,
        max_deposit: num(b.maxDeposit),
        min_withdrawal: num(b.minWithdrawal) ?? 0,
        max_withdrawal: num(b.maxWithdrawal),
        deposit_fee_pct: num(b.depositFeePct) ?? 0,
        withdrawal_fee_pct: num(b.withdrawalFeePct) ?? 0,
        instructions: b.instructions ?? null,
        pay_to_details: b.payToDetails ?? null,
        required_fields: Array.isArray(b.requiredFields) ? b.requiredFields.slice(0, 10) : [],
        sort_order: Number(b.sortOrder ?? 0),
    };
}
const str = (v, max) => (v === undefined || v === null || v === '' ? null : String(v).slice(0, max));
const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
const date = (v) => (v ? new Date(v) : null);
