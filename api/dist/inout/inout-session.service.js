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
var InoutSessionService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.InoutSessionService = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("typeorm");
const node_crypto_1 = require("node:crypto");
const inout_constants_1 = require("./inout.constants");
/**
 * Tokens are 32 random bytes, base64url. Only the SHA-256 hash is stored, so a
 * dump of inout_game_session cannot be replayed against the provider.
 */
let InoutSessionService = InoutSessionService_1 = class InoutSessionService {
    ds;
    constructor(ds) {
        this.ds = ds;
    }
    static hash(token) {
        return (0, node_crypto_1.createHash)('sha256').update(token, 'utf8').digest('hex');
    }
    /**
     * 24 bytes, base64url — 32 characters, 192 bits of entropy.
     *
     * Deliberately shorter than the 43 characters a 32-byte token produces.
     * Tokens get copied by hand into test harnesses and support tickets, and a
     * token that loses its last character to a copy-paste fails as INVALID_TOKEN
     * with no hint that truncation was the cause. 32 characters is still far
     * beyond guessable and much less likely to be mangled in transit.
     */
    static mint() {
        return (0, node_crypto_1.randomBytes)(24).toString('base64url');
    }
    /** Called by the launch endpoint, before the iframe URL is built. */
    async createLaunchToken(params) {
        const authToken = InoutSessionService_1.mint();
        const sessionId = (0, node_crypto_1.randomUUID)();
        const expiresAt = new Date(Date.now() + inout_constants_1.INOUT_AUTH_TOKEN_TTL_MS);
        await this.ds.query(`INSERT INTO inout_game_session
         (id, user_id, game_mode, currency, auth_token_hash, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`, [sessionId, params.userId, params.gameMode, params.currency, InoutSessionService_1.hash(authToken), expiresAt]);
        return { authToken, sessionId };
    }
    /**
     * `init` — exchange the launch token for a SessionToken.
     *
     * The launch token is deliberately NOT consumed. The provider re-initialises
     * an existing session (a reload, a reconnect, or their own test harness
     * running several scenarios against one token), and every one of those must
     * answer OK with the player's balance.
     *
     * Each init mints a fresh SessionToken and all of them stay valid until the
     * session expires, so a second init cannot invalidate a round already in
     * flight under an earlier token.
     */
    async activate(authToken) {
        const qr = this.ds.createQueryRunner();
        await qr.connect();
        await qr.startTransaction();
        try {
            const rows = await qr.query(`SELECT id, user_id, game_mode, currency, status, expires_at
           FROM inout_game_session
          WHERE auth_token_hash = ?
            AND status <> 'closed'
            AND expires_at > NOW()
          FOR UPDATE`, [InoutSessionService_1.hash(authToken)]);
            if (!rows.length) {
                await qr.rollbackTransaction();
                return null;
            }
            const sessionToken = InoutSessionService_1.mint();
            const expiresAt = new Date(Date.now() + inout_constants_1.INOUT_SESSION_TTL_MS);
            await qr.query(`INSERT INTO inout_session_token (token_hash, session_id, expires_at) VALUES (?, ?, ?)`, [InoutSessionService_1.hash(sessionToken), rows[0].id, expiresAt]);
            await qr.query(`UPDATE inout_game_session
            SET status = 'active',
                activated_at = COALESCE(activated_at, NOW()),
                session_token_hash = ?,
                expires_at = ?
          WHERE id = ?`, [InoutSessionService_1.hash(sessionToken), expiresAt, rows[0].id]);
            await qr.commitTransaction();
            return { session: { ...rows[0], status: 'active', expires_at: expiresAt }, sessionToken };
        }
        catch (err) {
            await qr.rollbackTransaction();
            throw err;
        }
        finally {
            await qr.release();
        }
    }
    /**
     * Resolve a SessionToken for bet/withdraw/rollback.
     *
     * Backend spec 3.1: if `init` returned no SessionToken, the AuthToken doubles
     * as one. We always return one, but we still accept the AuthToken so a
     * provider-side fallback cannot strand a live round.
     */
    async resolve(token, qr) {
        const h = InoutSessionService_1.hash(token);
        // Any SessionToken minted for this session works, and so does the launch
        // token itself (spec 3.1: it doubles as a SessionToken when none was given).
        const sql = `SELECT s.id, s.user_id, s.game_mode, s.currency, s.status, s.expires_at
                   FROM inout_game_session s
                   LEFT JOIN inout_session_token t ON t.session_id = s.id
                  WHERE t.token_hash = ? OR s.auth_token_hash = ?
                  ORDER BY (t.token_hash IS NOT NULL) DESC
                  LIMIT 1`;
        const rows = qr ? await qr.query(sql, [h, h]) : await this.ds.query(sql, [h, h]);
        return rows[0] ?? null;
    }
};
exports.InoutSessionService = InoutSessionService;
exports.InoutSessionService = InoutSessionService = InoutSessionService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [typeorm_1.DataSource])
], InoutSessionService);
