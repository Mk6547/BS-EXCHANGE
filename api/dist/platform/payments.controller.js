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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PaymentsController = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("typeorm");
const node_crypto_1 = require("node:crypto");
const decimal_js_1 = __importDefault(require("decimal.js"));
const jwt_auth_guard_1 = require("../auth/jwt-auth.guard");
const ledger_service_1 = require("./ledger.service");
const content_controller_1 = require("./content.controller");
/**
 * Player-facing deposits and withdrawals.
 *
 * Deposits credit nothing until an admin approves them — the player is simply
 * declaring that they sent money. Withdrawals debit immediately on request, so
 * the amount cannot be gambled while the payout is pending; a rejection puts it
 * straight back.
 */
let PaymentsController = class PaymentsController {
    ds;
    ledger;
    constructor(ds, ledger) {
        this.ds = ds;
        this.ledger = ledger;
    }
    async methods() {
        const rows = await this.ds.query(`SELECT * FROM payment_method WHERE enabled = 1 ORDER BY sort_order, display_name`);
        return { methods: rows.map(content_controller_1.shape) };
    }
    async createDeposit(req, body) {
        const [method] = await this.ds.query(`SELECT * FROM payment_method WHERE id = ? AND enabled = 1 AND supports_deposit = 1`, [body?.methodId]);
        if (!method)
            throw new common_1.BadRequestException({ message: 'That payment method is not available.' });
        const amount = money(body?.amount, 'Enter a valid amount.');
        const min = new decimal_js_1.default(method.min_deposit ?? 0);
        const max = method.max_deposit === null ? null : new decimal_js_1.default(method.max_deposit);
        if (amount.lt(min))
            throw new common_1.BadRequestException({ message: `Minimum deposit is ${min.toFixed(2)}.` });
        if (max && amount.gt(max))
            throw new common_1.BadRequestException({ message: `Maximum deposit is ${max.toFixed(2)}.` });
        const id = (0, node_crypto_1.randomUUID)();
        const reference = ledger_service_1.LedgerService.reference('DP');
        await this.ds.query(`INSERT INTO deposit (id, reference, user_id, method_id, currency, amount, player_note, proof_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [id, reference, req.user.id, method.id, method.currency, amount.toFixed(2),
            body?.note?.slice(0, 255) ?? null, body?.proofUrl?.slice(0, 512) ?? null]);
        return {
            id,
            reference,
            status: 'pending',
            amount: amount.toFixed(2),
            currency: method.currency,
            // Only revealed once a deposit exists, so the account details are not
            // sitting on a public endpoint for anyone to scrape.
            payTo: method.pay_to_details,
            instructions: method.instructions,
        };
    }
    async myDeposits(req, q) {
        const limit = Math.min(Math.max(Number(q.limit ?? 25), 1), 100);
        const rows = await this.ds.query(`SELECT d.reference, d.amount, d.credited, d.currency, d.status, d.admin_note, d.created_at,
              m.display_name AS method
         FROM deposit d JOIN payment_method m ON m.id = d.method_id
        WHERE d.user_id = ? ORDER BY d.created_at DESC LIMIT ?`, [req.user.id, limit]);
        return { deposits: rows };
    }
    async createWithdrawal(req, body) {
        const [method] = await this.ds.query(`SELECT * FROM payment_method WHERE id = ? AND enabled = 1 AND supports_withdrawal = 1`, [body?.methodId]);
        if (!method)
            throw new common_1.BadRequestException({ message: 'That withdrawal method is not available.' });
        const amount = money(body?.amount, 'Enter a valid amount.');
        const min = new decimal_js_1.default(method.min_withdrawal ?? 0);
        const max = method.max_withdrawal === null ? null : new decimal_js_1.default(method.max_withdrawal);
        if (amount.lt(min))
            throw new common_1.BadRequestException({ message: `Minimum withdrawal is ${min.toFixed(2)}.` });
        if (max && amount.gt(max))
            throw new common_1.BadRequestException({ message: `Maximum withdrawal is ${max.toFixed(2)}.` });
        const required = (0, content_controller_1.parseJson)(method.required_fields) ?? [];
        const details = body?.details ?? {};
        const missing = required.filter((f) => !String(details[f] ?? '').trim());
        if (missing.length) {
            throw new common_1.BadRequestException({ message: `Please fill in: ${missing.join(', ')}.` });
        }
        const fee = amount.times(new decimal_js_1.default(method.withdrawal_fee_pct ?? 0)).dividedBy(100);
        const payable = amount.minus(fee);
        const id = (0, node_crypto_1.randomUUID)();
        const reference = ledger_service_1.LedgerService.reference('WD');
        try {
            await this.ledger.inTx(async (qr) => {
                // Debit on request. Holding the money aside is what stops a player
                // withdrawing and gambling the same balance before payout.
                await this.ledger.move(qr, {
                    userId: req.user.id,
                    currency: method.currency,
                    delta: amount.neg(),
                    reference: `wd:${reference}`,
                    meta: { methodId: method.id },
                });
                await qr.query(`INSERT INTO withdrawal (id, reference, user_id, method_id, currency, amount, fee, payable, details)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [id, reference, req.user.id, method.id, method.currency,
                    amount.toFixed(2), fee.toFixed(2), payable.toFixed(2), JSON.stringify(details)]);
            });
        }
        catch (err) {
            throw new common_1.BadRequestException({ message: err?.message ?? 'Withdrawal could not be created.' });
        }
        return { id, reference, status: 'pending', amount: amount.toFixed(2), fee: fee.toFixed(2), payable: payable.toFixed(2) };
    }
    async myWithdrawals(req, q) {
        const limit = Math.min(Math.max(Number(q.limit ?? 25), 1), 100);
        const rows = await this.ds.query(`SELECT w.reference, w.amount, w.fee, w.payable, w.currency, w.status, w.admin_note, w.created_at,
              m.display_name AS method
         FROM withdrawal w JOIN payment_method m ON m.id = w.method_id
        WHERE w.user_id = ? ORDER BY w.created_at DESC LIMIT ?`, [req.user.id, limit]);
        return { withdrawals: rows };
    }
};
exports.PaymentsController = PaymentsController;
__decorate([
    (0, common_1.Get)('methods'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], PaymentsController.prototype, "methods", null);
__decorate([
    (0, common_1.Post)('deposits'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], PaymentsController.prototype, "createDeposit", null);
__decorate([
    (0, common_1.Get)('deposits'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], PaymentsController.prototype, "myDeposits", null);
__decorate([
    (0, common_1.Post)('withdrawals'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], PaymentsController.prototype, "createWithdrawal", null);
__decorate([
    (0, common_1.Get)('withdrawals'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], PaymentsController.prototype, "myWithdrawals", null);
exports.PaymentsController = PaymentsController = __decorate([
    (0, common_1.Controller)('payments'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    __metadata("design:paramtypes", [typeorm_1.DataSource,
        ledger_service_1.LedgerService])
], PaymentsController);
function money(raw, message) {
    const s = String(raw ?? '').trim();
    if (!/^\d+(\.\d{1,2})?$/.test(s))
        throw new common_1.BadRequestException({ message });
    const d = new decimal_js_1.default(s);
    if (d.lte(0))
        throw new common_1.BadRequestException({ message });
    return d;
}
