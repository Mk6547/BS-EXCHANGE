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
Object.defineProperty(exports, "__esModule", { value: true });
exports.LedgerService = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("typeorm");
const node_crypto_1 = require("node:crypto");
const decimal_js_1 = __importDefault(require("decimal.js"));
/**
 * The one place outside the InOut webhook handler where balances change.
 *
 * Everything here locks the wallet row first and writes a wallet_ledger entry
 * in the same transaction, so the ledger stays the authoritative record of the
 * balance no matter which part of the system moved the money.
 */
let LedgerService = class LedgerService {
    ds;
    constructor(ds) {
        this.ds = ds;
    }
    /** Short human reference for deposits and withdrawals, e.g. DP-7F3K2Q. */
    static reference(prefix) {
        const body = (0, node_crypto_1.randomUUID)().replace(/-/g, '').slice(0, 6).toUpperCase();
        return `${prefix}-${body}`;
    }
    async balanceOf(userId, currency) {
        const [row] = await this.ds.query(`SELECT balance FROM wallet WHERE user_id = ? AND currency = ?`, [userId, currency]);
        return new decimal_js_1.default(row?.balance ?? 0);
    }
    /**
     * Apply a signed change inside an existing transaction.
     * `reference` must be unique — the ledger has a unique index on it, which is
     * what stops an approval being applied twice if a request is retried.
     */
    async move(qr, p) {
        const [row] = await qr.query(`SELECT balance, status FROM wallet WHERE user_id = ? AND currency = ? FOR UPDATE`, [p.userId, p.currency]);
        if (!row)
            throw new Error('No wallet for that player and currency.');
        if (row.status !== 'active')
            throw new Error('That wallet is not active.');
        const before = new decimal_js_1.default(row.balance);
        const after = before.plus(p.delta);
        if (after.isNegative())
            throw new Error('That would take the balance below zero.');
        await qr.query(`UPDATE wallet SET balance = ? WHERE user_id = ? AND currency = ?`, [
            after.toFixed(),
            p.userId,
            p.currency,
        ]);
        await qr.query(`INSERT INTO wallet_ledger (user_id, currency, delta, balance_after, reference, meta)
       VALUES (?, ?, ?, ?, ?, ?)`, [p.userId, p.currency, p.delta.toFixed(), after.toFixed(), p.reference, JSON.stringify(p.meta ?? {})]);
        return { before, after };
    }
    /** Run work in a transaction, releasing the connection either way. */
    async inTx(fn) {
        const qr = this.ds.createQueryRunner();
        await qr.connect();
        await qr.startTransaction();
        try {
            const out = await fn(qr);
            await qr.commitTransaction();
            return out;
        }
        catch (err) {
            await qr.rollbackTransaction();
            throw err;
        }
        finally {
            await qr.release();
        }
    }
};
exports.LedgerService = LedgerService;
exports.LedgerService = LedgerService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [typeorm_1.DataSource])
], LedgerService);
