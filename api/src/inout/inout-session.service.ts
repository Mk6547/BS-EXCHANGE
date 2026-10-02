import { Injectable } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { INOUT_AUTH_TOKEN_TTL_MS, INOUT_SESSION_TTL_MS } from './inout.constants';

export interface InoutSession {
  id: string;
  user_id: string;
  game_mode: string;
  currency: string;
  status: 'created' | 'active' | 'closed';
  expires_at: Date;
}

/**
 * Tokens are 32 random bytes, base64url. Only the SHA-256 hash is stored, so a
 * dump of inout_game_session cannot be replayed against the provider.
 */
@Injectable()
export class InoutSessionService {
  constructor(private readonly ds: DataSource) {}

  static hash(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex');
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
  private static mint(): string {
    return randomBytes(24).toString('base64url');
  }

  /** Called by the launch endpoint, before the iframe URL is built. */
  async createLaunchToken(params: {
    userId: string;
    gameMode: string;
    currency: string;
  }): Promise<{ authToken: string; sessionId: string }> {
    const authToken = InoutSessionService.mint();
    const sessionId = randomUUID();
    const expiresAt = new Date(Date.now() + INOUT_AUTH_TOKEN_TTL_MS);

    await this.ds.query(
      `INSERT INTO inout_game_session
         (id, user_id, game_mode, currency, auth_token_hash, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [sessionId, params.userId, params.gameMode, params.currency, InoutSessionService.hash(authToken), expiresAt],
    );
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
  async activate(authToken: string): Promise<{ session: InoutSession; sessionToken: string } | null> {
    const qr = this.ds.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      const rows = await qr.query(
        `SELECT id, user_id, game_mode, currency, status, expires_at
           FROM inout_game_session
          WHERE auth_token_hash = ?
            AND status <> 'closed'
            AND expires_at > NOW()
          FOR UPDATE`,
        [InoutSessionService.hash(authToken)],
      );
      if (!rows.length) {
        await qr.rollbackTransaction();
        return null;
      }

      const sessionToken = InoutSessionService.mint();
      const expiresAt = new Date(Date.now() + INOUT_SESSION_TTL_MS);

      await qr.query(
        `INSERT INTO inout_session_token (token_hash, session_id, expires_at) VALUES (?, ?, ?)`,
        [InoutSessionService.hash(sessionToken), rows[0].id, expiresAt],
      );
      await qr.query(
        `UPDATE inout_game_session
            SET status = 'active',
                activated_at = COALESCE(activated_at, NOW()),
                session_token_hash = ?,
                expires_at = ?
          WHERE id = ?`,
        [InoutSessionService.hash(sessionToken), expiresAt, rows[0].id],
      );

      await qr.commitTransaction();
      return { session: { ...rows[0], status: 'active', expires_at: expiresAt }, sessionToken };
    } catch (err) {
      await qr.rollbackTransaction();
      throw err;
    } finally {
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
  async resolve(token: string, qr?: QueryRunner): Promise<InoutSession | null> {
    const h = InoutSessionService.hash(token);
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
}