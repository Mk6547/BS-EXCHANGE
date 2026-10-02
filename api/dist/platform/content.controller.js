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
Object.defineProperty(exports, "__esModule", { value: true });
exports.ContentController = void 0;
exports.shape = shape;
exports.parseJson = parseJson;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("typeorm");
/**
 * Public site content. No authentication — these drive the home page for
 * signed-out visitors too. Nothing here exposes configuration secrets: the
 * payment-method rows returned omit pay_to_details, which is only shown once
 * a player has actually started a deposit.
 */
let ContentController = class ContentController {
    ds;
    constructor(ds) {
        this.ds = ds;
    }
    async banners() {
        const rows = await this.ds.query(`SELECT id, title, subtitle, image_url, mobile_image_url, cta_text, cta_link
         FROM banner
        WHERE enabled = 1
          AND (starts_at IS NULL OR starts_at <= NOW())
          AND (ends_at   IS NULL OR ends_at   >= NOW())
        ORDER BY sort_order, created_at`);
        return { banners: rows };
    }
    async promotions() {
        const rows = await this.ds.query(`SELECT id, slug, title, summary, body, image_url, bonus_pct, min_deposit, max_bonus, terms, ends_at
         FROM promotion
        WHERE enabled = 1
          AND (starts_at IS NULL OR starts_at <= NOW())
          AND (ends_at   IS NULL OR ends_at   >= NOW())
        ORDER BY sort_order, created_at`);
        return { promotions: rows };
    }
    async settings() {
        const rows = await this.ds.query(`SELECT key_name, value FROM site_setting`);
        const out = {};
        for (const r of rows)
            out[r.key_name] = r.value;
        return out;
    }
    async paymentMethods() {
        const rows = await this.ds.query(`SELECT id, code, display_name, kind, logo_url, currency,
              supports_deposit, supports_withdrawal,
              min_deposit, max_deposit, min_withdrawal, max_withdrawal,
              deposit_fee_pct, withdrawal_fee_pct, instructions, required_fields
         FROM payment_method
        WHERE enabled = 1
        ORDER BY sort_order, display_name`);
        return { methods: rows.map(shape) };
    }
};
exports.ContentController = ContentController;
__decorate([
    (0, common_1.Get)('banners'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], ContentController.prototype, "banners", null);
__decorate([
    (0, common_1.Get)('promotions'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], ContentController.prototype, "promotions", null);
__decorate([
    (0, common_1.Get)('settings'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], ContentController.prototype, "settings", null);
__decorate([
    (0, common_1.Get)('payment-methods'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], ContentController.prototype, "paymentMethods", null);
exports.ContentController = ContentController = __decorate([
    (0, common_1.Controller)('content'),
    __metadata("design:paramtypes", [typeorm_1.DataSource])
], ContentController);
function shape(r) {
    return {
        id: r.id,
        code: r.code,
        displayName: r.display_name,
        kind: r.kind,
        logoUrl: r.logo_url,
        currency: r.currency,
        supportsDeposit: Boolean(r.supports_deposit),
        supportsWithdrawal: Boolean(r.supports_withdrawal),
        minDeposit: Number(r.min_deposit ?? 0).toFixed(2),
        maxDeposit: r.max_deposit === null ? null : Number(r.max_deposit).toFixed(2),
        minWithdrawal: Number(r.min_withdrawal ?? 0).toFixed(2),
        maxWithdrawal: r.max_withdrawal === null ? null : Number(r.max_withdrawal).toFixed(2),
        depositFeePct: Number(r.deposit_fee_pct ?? 0),
        withdrawalFeePct: Number(r.withdrawal_fee_pct ?? 0),
        instructions: r.instructions,
        requiredFields: parseJson(r.required_fields) ?? [],
    };
}
function parseJson(v) {
    if (v === null || v === undefined)
        return null;
    if (typeof v === 'object')
        return v;
    try {
        return JSON.parse(v);
    }
    catch {
        return null;
    }
}
