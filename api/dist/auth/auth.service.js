"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var AuthService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthService = exports.AuthError = void 0;
const common_1 = require("@nestjs/common");
const jwt_1 = require("@nestjs/jwt");
const typeorm_1 = require("typeorm");
const node_crypto_1 = require("node:crypto");
const bcrypt = __importStar(require("bcryptjs"));
class AuthError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
exports.AuthError = AuthError;
let AuthService = AuthService_1 = class AuthService {
    ds;
    jwt;
    log = new common_1.Logger(AuthService_1.name);
    constructor(ds, jwt) {
        this.ds = ds;
        this.jwt = jwt;
    }
    /**
     * Decide whether the input is an email or a phone number, and normalise it.
     * Phone numbers are stored in E.164 so the same person cannot register twice
     * as 03001234567 and +923001234567.
     */
    static parseIdentifier(raw) {
        const value = (raw ?? '').trim();
        if (value.includes('@')) {
            const email = value.toLowerCase();
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
                throw new AuthError('INVALID_EMAIL', 'That email address does not look right.');
            }
            return { kind: 'email', value: email };
        }
        let digits = value.replace(/[\s()-]/g, '');
        if (digits.startsWith('00'))
            digits = `+${digits.slice(2)}`;
        // A leading 0 is the local Pakistani form; +92 is the same number.
        if (/^0\d{9,10}$/.test(digits))
            digits = `+92${digits.slice(1)}`;
        if (!/^\+\d{8,15}$/.test(digits)) {
            throw new AuthError('INVALID_PHONE', 'Enter an email address or a phone number with country code.');
        }
        return { kind: 'phone', value: digits };
    }
    static assertPassword(password) {
        if (!password || password.length < 8) {
            throw new AuthError('WEAK_PASSWORD', 'Use at least 8 characters.');
        }
        if (password.length > 200) {
            throw new AuthError('WEAK_PASSWORD', 'That password is too long.');
        }
    }
    async register(input) {
        const id = AuthService_1.parseIdentifier(input.identifier);
        AuthService_1.assertPassword(input.password);
        const existing = await this.ds.query(`SELECT id FROM users WHERE ${id.kind} = ?`, [id.value]);
        if (existing.length) {
            throw new AuthError('ALREADY_REGISTERED', 'An account already uses that email or phone.');
        }
        // bcryptjs rather than native bcrypt: no compiler on shared hosting.
        // Cost 10 keeps login near 100ms on a shared CPU.
        const hash = await bcrypt.hash(input.password, 10);
        const userId = (0, node_crypto_1.randomUUID)();
        // PKR by default; DEFAULT_CURRENCY lets a second market be opened without
        // a code change. The provider quotes all fiat to 2 decimal places.
        const currency = (input.currency ?? process.env.DEFAULT_CURRENCY ?? 'PKR').toUpperCase();
        const nickname = input.nickname?.trim() || defaultNickname(id);
        const qr = this.ds.createQueryRunner();
        await qr.connect();
        await qr.startTransaction();
        try {
            await qr.query(`INSERT INTO users (id, email, phone, password_hash, currency, role, country_code, nickname, status)
         VALUES (?, ?, ?, ?, ?, 'player', ?, ?, 'active')`, [
                userId,
                id.kind === 'email' ? id.value : null,
                id.kind === 'phone' ? id.value : null,
                hash,
                currency,
                input.countryCode ?? null,
                nickname,
            ]);
            // Every player needs a wallet row before they can be debited.
            await qr.query(`INSERT INTO wallet (user_id, currency, balance, status) VALUES (?, ?, 0, 'active')`, [userId, currency]);
            await qr.commitTransaction();
        }
        catch (err) {
            await qr.rollbackTransaction();
            throw err;
        }
        finally {
            await qr.release();
        }
        return this.issue({ id: userId, nickname, role: 'player', currency });
    }
    async login(input) {
        const id = AuthService_1.parseIdentifier(input.identifier);
        await this.assertNotThrottled(id.value, input.ip);
        const rows = await this.ds.query(`SELECT id, nickname, password_hash, status, role, currency FROM users WHERE ${id.kind} = ?`, [id.value]);
        const user = rows[0];
        // Hash even when no user exists, so response time does not reveal
        // which accounts are registered.
        const ok = await bcrypt.compare(input.password, user?.password_hash ?? '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin');
        await this.recordAttempt(id.value, input.ip, Boolean(user && ok));
        if (!user || !ok) {
            throw new AuthError('BAD_CREDENTIALS', 'That email or password is not correct.');
        }
        if (user.status !== 'active') {
            throw new AuthError('ACCOUNT_LOCKED', 'This account is not available. Contact support.');
        }
        await this.ds.query(`UPDATE users SET last_login_at = NOW() WHERE id = ?`, [user.id]);
        return this.issue(user);
    }
    async profile(userId) {
        const rows = await this.ds.query(`SELECT u.id, u.nickname, u.email, u.phone, u.currency, u.role, u.owner_id,
              COALESCE(w.balance, 0) AS balance,
              o.role AS owner_role
         FROM users u
         LEFT JOIN wallet w ON w.user_id = u.id AND w.currency = u.currency
         LEFT JOIN users o ON o.id = u.owner_id
        WHERE u.id = ?`, [userId]);
        const u = rows[0];
        if (!u)
            throw new AuthError('NOT_FOUND', 'Account not found.');
        // WhatsApp support button: shown only to players who self-registered
        // (no owner) or belong directly to the master. Players under an admin or a
        // mini admin are supported by their own agent, so they don't see it.
        const isSelfOrMaster = u.owner_id == null || u.owner_role === 'master';
        let whatsapp = { show: false, number: '' };
        if (isSelfOrMaster) {
            const cfg = await this.ds.query(`SELECT key_name, value FROM site_setting WHERE key_name IN ('whatsapp_float_number','whatsapp_float_enabled')`).catch(() => []);
            const map = {};
            for (const r of cfg)
                map[r.key_name] = r.value;
            const num = (map['whatsapp_float_number'] || '').trim();
            const on = (map['whatsapp_float_enabled'] ?? '1') !== '0';
            if (on && num)
                whatsapp = { show: true, number: num };
        }
        return {
            id: u.id,
            nickname: u.nickname,
            email: u.email,
            phone: u.phone,
            currency: u.currency,
            role: u.role,
            balance: Number(u.balance).toFixed(2),
            whatsapp,
        };
    }
    issue(user) {
        const token = this.jwt.sign({ sub: user.id, nickname: user.nickname, role: user.role });
        return {
            token,
            user: { id: user.id, nickname: user.nickname, role: user.role, currency: user.currency },
        };
    }
    /**
     * Throttle by account and by IP. Backed by the database rather than memory,
     * because Passenger restarts the process freely and an in-memory counter
     * would reset with it — which is exactly what an attacker would wait for.
     */
    async assertNotThrottled(identifier, ip) {
        const [byAccount] = await this.ds.query(`SELECT COUNT(*) AS n FROM login_attempt
        WHERE identifier = ? AND success = 0 AND created_at > DATE_SUB(NOW(), INTERVAL 15 MINUTE)`, [identifier]);
        const [byIp] = await this.ds.query(`SELECT COUNT(*) AS n FROM login_attempt
        WHERE ip = ? AND success = 0 AND created_at > DATE_SUB(NOW(), INTERVAL 15 MINUTE)`, [ip]);
        if (Number(byAccount.n) >= 8 || Number(byIp.n) >= 30) {
            throw new AuthError('TOO_MANY_ATTEMPTS', 'Too many attempts. Try again in 15 minutes.');
        }
    }
    async recordAttempt(identifier, ip, success) {
        await this.ds.query(`INSERT INTO login_attempt (identifier, ip, success) VALUES (?, ?, ?)`, [identifier, ip, success ? 1 : 0]);
    }
};
exports.AuthService = AuthService;
exports.AuthService = AuthService = AuthService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [typeorm_1.DataSource,
        jwt_1.JwtService])
], AuthService);
function defaultNickname(id) {
    const base = id.kind === 'email' ? id.value.split('@')[0] : `player${id.value.slice(-4)}`;
    return base.replace(/[^a-zA-Z0-9_]/g, '').slice(0, 20) || 'player';
}
