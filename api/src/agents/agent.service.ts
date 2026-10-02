import { Injectable } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import { randomUUID } from 'node:crypto';
import Decimal from 'decimal.js';
import * as bcrypt from 'bcryptjs';
import { LedgerService } from '../platform/ledger.service';

export class AgentError extends Error {}

/**
 * The master / admin / player hierarchy.
 *
 * - master  : you. Full control, creates and funds admins, sees everyone.
 * - admin   : an agent. Own players only, a float, a win/loss sheet.
 * - player  : logs in and plays; owned by exactly one admin.
 *
 * Float and win/loss are deliberately separate. The float is a spending
 * allowance that only falls as the admin credits players — a player's
 * withdrawal never refills it. Win/loss is the live house result on the admin's
 * players, split by commission, settled off-system.
 */
@Injectable()
export class AgentService {
  constructor(
    private readonly ds: DataSource,
    private readonly ledger: LedgerService,
  ) {}

  // ------------------------------------------------------------- lookups

  async userRow(id: string) {
    const [u] = await this.ds.query(
      `SELECT u.id, u.nickname, u.email, u.phone, u.role, u.owner_id, u.commission_pct,
              u.float_limit, u.float_used, u.currency, u.status, u.created_at,
              COALESCE(w.balance,0) AS balance
         FROM users u LEFT JOIN wallet w ON w.user_id = u.id AND w.currency = u.currency WHERE u.id = ?`,
      [id],
    );
    return u ?? null;
  }

  /**
   * Resolve the settlement chain above a player.
   *
   * A player is owned by either an admin or a mini admin. If the owner is a mini
   * admin, its owner is the admin. We return whichever of admin / mini apply,
   * each with its share of the WHOLE (commission_pct). The caller splits by:
   *   mini_share   = house_pl * mini%           (0 if no mini)
   *   admin_share  = house_pl * (admin% - mini%) (the admin keeps the remainder
   *                                               of its own share)
   *   master_share = house_pl - mini_share - admin_share
   */
  async chainOf(playerId: string): Promise<
    { adminId: string; adminPct: Decimal; miniId: string | null; miniPct: Decimal } | null
  > {
    const [owner] = await this.ds.query(
      `SELECT o.id, o.role, o.owner_id, o.commission_pct FROM users p
         JOIN users o ON o.id = p.owner_id WHERE p.id = ?`, [playerId],
    );
    if (!owner) return null;

    if (owner.role === 'mini') {
      // owner is a mini admin; its owner is the admin.
      const [admin] = await this.ds.query(
        `SELECT id, commission_pct FROM users WHERE id = ?`, [owner.owner_id],
      );
      return {
        adminId: admin?.id ?? owner.owner_id,
        adminPct: new Decimal(admin?.commission_pct ?? 0),
        miniId: owner.id,
        miniPct: new Decimal(owner.commission_pct ?? 0),
      };
    }
    // owner is an admin (or master-owned: role master => no split, pct 0).
    return {
      adminId: owner.id,
      adminPct: new Decimal(owner.role === 'master' ? 0 : (owner.commission_pct ?? 0)),
      miniId: null,
      miniPct: new Decimal(0),
    };
  }

  // ---------------------------------------------------------- mini admins

  /** Mini admins under one admin, with their float and share. */
  async listMinis(adminId: string) {
    const rows = await this.ds.query(
      `SELECT m.id, m.nickname, m.status, m.commission_pct, m.float_limit, m.float_used,
              (SELECT COUNT(*) FROM users p WHERE p.owner_id = m.id AND p.role = 'player') AS players,
              (SELECT COALESCE(SUM(mini_share),0) FROM agent_winloss w WHERE w.mini_id = m.id) AS mini_share
         FROM users m WHERE m.owner_id = ? AND m.role = 'mini' ORDER BY m.nickname`,
      [adminId],
    );
    return rows.map((m: any) => ({
      id: m.id, nickname: m.nickname, status: m.status,
      sharePct: Number(m.commission_pct).toFixed(1),
      creditLimit: Number(m.float_limit).toFixed(2),
      creditUsed: Number(m.float_used).toFixed(2),
      creditLeft: (Number(m.float_limit) - Number(m.float_used)).toFixed(2),
      players: Number(m.players),
      miniShare: Number(m.mini_share).toFixed(2),
    }));
  }

  /** Whole tree for the master: every admin's mini admins. */
  async allMinis() {
    const rows = await this.ds.query(
      `SELECT m.id, m.nickname, m.status, m.commission_pct, m.owner_id, a.nickname AS admin_name,
              a.commission_pct AS admin_pct
         FROM users m JOIN users a ON a.id = m.owner_id
        WHERE m.role = 'mini' ORDER BY a.nickname, m.nickname`,
    );
    return rows.map((m: any) => ({
      id: m.id, nickname: m.nickname, status: m.status,
      sharePct: Number(m.commission_pct).toFixed(1),
      adminId: m.owner_id, admin: m.admin_name, adminPct: Number(m.admin_pct).toFixed(1),
    }));
  }

  /** An admin creates a mini admin. Share cannot exceed the admin's own. */
  async createMini(p: { adminId: string; nickname: string; password: string; sharePct: string }) {
    const nickname = String(p.nickname ?? '').trim();
    if (nickname.length < 3) throw new AgentError('Username must be at least 3 characters.');
    if (String(p.password ?? '').length < 6) throw new AgentError('Password must be at least 6 characters.');

    const [admin] = await this.ds.query(`SELECT role, commission_pct FROM users WHERE id = ?`, [p.adminId]);
    if (!admin || admin.role !== 'admin') throw new AgentError('Only an admin can create a mini admin.');
    const share = new Decimal(p.sharePct || 0);
    if (share.lt(0)) throw new AgentError('Share cannot be negative.');
    if (share.gt(admin.commission_pct)) {
      throw new AgentError(`Share cannot be more than your own ${Number(admin.commission_pct).toFixed(1)}%.`);
    }
    const [taken] = await this.ds.query(`SELECT id FROM users WHERE nickname = ?`, [nickname]);
    if (taken) throw new AgentError('That username is already in use.');

    const id = randomUUID();
    const hash = await bcrypt.hash(p.password, 10);
    await this.ds.query(
      `INSERT INTO users (id, nickname, password_hash, role, owner_id, commission_pct, currency, status)
       VALUES (?,?,?, 'mini', ?, ?, 'PKR', 'active')`,
      [id, nickname, hash, p.adminId, share.toFixed(3)],
    );
    return { id, nickname };
  }

  async updateMini(p: { adminId: string; miniId: string; sharePct?: string; status?: string; password?: string }) {
    const [mini] = await this.ds.query(`SELECT owner_id FROM users WHERE id = ? AND role = 'mini'`, [p.miniId]);
    if (!mini) throw new AgentError('No such mini admin.');
    if (mini.owner_id !== p.adminId) throw new AgentError('That mini admin is not yours.');

    const fields: string[] = []; const args: any[] = [];
    if (p.sharePct !== undefined) {
      const [admin] = await this.ds.query(`SELECT commission_pct FROM users WHERE id = ?`, [p.adminId]);
      const share = new Decimal(p.sharePct);
      if (share.lt(0) || share.gt(admin.commission_pct)) {
        throw new AgentError(`Share must be between 0 and your own ${Number(admin.commission_pct).toFixed(1)}%.`);
      }
      fields.push('commission_pct = ?'); args.push(share.toFixed(3));
    }
    if (p.status && ['active', 'suspended'].includes(p.status)) { fields.push('status = ?'); args.push(p.status); }
    if (p.password) {
      if (p.password.length < 6) throw new AgentError('Password must be at least 6 characters.');
      fields.push('password_hash = ?'); args.push(await bcrypt.hash(p.password, 10));
    }
    if (!fields.length) throw new AgentError('Nothing to change.');
    await this.ds.query(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, [...args, p.miniId]);
    return { id: p.miniId };
  }

  /** Delete a mini admin; its players move up to the parent admin. */
  async deleteMini(p: { adminId: string; miniId: string }) {
    const [mini] = await this.ds.query(`SELECT owner_id FROM users WHERE id = ? AND role = 'mini'`, [p.miniId]);
    if (!mini) throw new AgentError('No such mini admin.');
    if (mini.owner_id !== p.adminId) throw new AgentError('That mini admin is not yours.');
    let moved = 0;
    await this.ledger.inTx(async (qr: QueryRunner) => {
      const res = await qr.query(`UPDATE users SET owner_id = ? WHERE owner_id = ? AND role = 'player'`, [p.adminId, p.miniId]);
      moved = res.affectedRows ?? 0;
      await qr.query(`DELETE FROM users WHERE id = ? AND role = 'mini'`, [p.miniId]);
    });
    return { id: p.miniId, playersMovedToAdmin: moved };
  }

  /**
   * An admin funds a mini admin's float out of the admin's own float.
   * Credit: admin float_used goes up (admin spends), mini float_limit goes up.
   * Deduct: reverse, but never below what the mini has already handed to players,
   * and it returns to the admin's available float.
   */
  async fundMini(p: { adminId: string; miniId: string; kind: 'deposit' | 'credit' | 'deduct'; amount: string; note?: string }) {
    const amount = new Decimal(p.amount);
    if (amount.lte(0)) throw new AgentError('Enter an amount above zero.');
    const [mini] = await this.ds.query(
      `SELECT owner_id, float_limit, float_used FROM users WHERE id = ? AND role = 'mini'`, [p.miniId],
    );
    if (!mini) throw new AgentError('No such mini admin.');
    if (mini.owner_id !== p.adminId) throw new AgentError('That mini admin is not yours.');
    const [admin] = await this.ds.query(`SELECT float_limit, float_used FROM users WHERE id = ?`, [p.adminId]);
    const adminLeft = new Decimal(admin.float_limit).minus(admin.float_used);

    await this.ledger.inTx(async (qr: QueryRunner) => {
      if (p.kind === 'credit' || p.kind === 'deposit') {
        if (amount.gt(adminLeft)) throw new AgentError(`You only have ${adminLeft.toFixed(2)} credit left to give.`);
        await qr.query(`UPDATE users SET float_used = float_used + ? WHERE id = ?`, [amount.toFixed(2), p.adminId]);
        await qr.query(`UPDATE users SET float_limit = float_limit + ? WHERE id = ?`, [amount.toFixed(2), p.miniId]);
      } else {
        const nextLimit = new Decimal(mini.float_limit).minus(amount);
        if (nextLimit.lt(new Decimal(mini.float_used))) {
          throw new AgentError('Cannot deduct below what the mini admin has already given to players.');
        }
        await qr.query(`UPDATE users SET float_limit = float_limit - ? WHERE id = ?`, [amount.toFixed(2), p.miniId]);
        await qr.query(`UPDATE users SET float_used = float_used - ? WHERE id = ?`, [amount.toFixed(2), p.adminId]);
      }
      await qr.query(
        `INSERT INTO agent_ledger (actor_id, subject_id, kind, amount, note) VALUES (?,?,?,?,?)`,
        [p.adminId, p.miniId, 'minifund.' + p.kind, (p.kind === 'deduct' ? amount.negated() : amount).toFixed(2), p.note ?? null],
      );
    });
    const [after] = await this.ds.query(`SELECT float_limit, float_used FROM users WHERE id = ?`, [p.miniId]);
    return { creditLeft: (Number(after.float_limit) - Number(after.float_used)).toFixed(2) };
  }

  // ------------------------------------------------------------- max bets

  async categories() {
    return this.ds.query(`SELECT key_name, label FROM bet_category ORDER BY sort_order`);
  }

  private parseMax(v: any): Record<string, number> {
    if (!v) return {};
    if (typeof v === 'object') return v;
    try { return JSON.parse(v) || {}; } catch { return {}; }
  }

  /** The effective max bet for a player in one category: their own limit. */
  async maxBetFor(playerId: string, category: string): Promise<number> {
    const [row] = await this.ds.query(`SELECT max_bets FROM users WHERE id = ?`, [playerId]);
    if (!row) return 0;
    const m = this.parseMax(row.max_bets);
    return Number(m[category] ?? 0);
  }

  /** Clamp a would-be limit map to a ceiling map (no value above the ceiling). */
  private clampToCeiling(limits: Record<string, any>, ceiling: Record<string, number>, hasCeiling: boolean) {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(limits || {})) {
      let n = Math.max(0, Number(v) || 0);
      if (hasCeiling) {
        const cap = Number(ceiling[k] ?? 0);
        // If a ceiling is set for this category, the player cannot exceed it.
        if (cap > 0 && n > cap) n = cap;
      }
      out[k] = n;
    }
    return out;
  }

  async setMaxBets(p: { actorId: string; actorRole: string; targetId: string; maxBets: Record<string, any> }) {
    const [target] = await this.ds.query(`SELECT id, role, owner_id FROM users WHERE id = ?`, [p.targetId]);
    if (!target) throw new AgentError('No such account.');

    if (p.actorRole === 'master') {
      // Master sets an admin's ceiling (or a player's, unclamped).
      await this.ds.query(`UPDATE users SET max_bets = ? WHERE id = ?`,
        [JSON.stringify(this.clampToCeiling(p.maxBets, {}, false)), p.targetId]);
      return { id: p.targetId };
    }

    // An admin may only set their own players, clamped to the admin's ceiling.
    if (target.owner_id !== p.actorId) throw new AgentError('That account is not on your panel.');
    const [me] = await this.ds.query(`SELECT max_bets FROM users WHERE id = ?`, [p.actorId]);
    const ceiling = this.parseMax(me?.max_bets);
    await this.ds.query(`UPDATE users SET max_bets = ? WHERE id = ?`,
      [JSON.stringify(this.clampToCeiling(p.maxBets, ceiling, true)), p.targetId]);
    return { id: p.targetId };
  }

  async getMaxBets(id: string) {
    const [row] = await this.ds.query(`SELECT max_bets FROM users WHERE id = ?`, [id]);
    return this.parseMax(row?.max_bets);
  }

  // --------------------------------------------------------- master: admins

  async listAdmins() {
    const rows = await this.ds.query(
      `SELECT a.id, a.nickname, a.status, a.commission_pct, a.float_limit, a.float_used,
              (SELECT COUNT(*) FROM users p WHERE p.owner_id = a.id AND p.role = 'player') AS players,
              (SELECT COUNT(*) FROM users m WHERE m.owner_id = a.id AND m.role = 'mini') AS minis,
              (SELECT COALESCE(SUM(w.balance),0) FROM users p JOIN wallet w ON w.user_id = p.id AND w.currency = p.currency WHERE p.owner_id = a.id AND p.role = 'player') AS players_balance,
              (SELECT COALESCE(SUM(house_pl),0) FROM agent_winloss w WHERE w.admin_id = a.id) AS house_pl,
              (SELECT COALESCE(SUM(master_share),0) FROM agent_winloss w WHERE w.admin_id = a.id) AS master_share,
              (SELECT COALESCE(SUM(admin_share),0) FROM agent_winloss w WHERE w.admin_id = a.id) AS admin_share
         FROM users a WHERE a.role = 'admin' ORDER BY a.nickname`,
    );
    return rows.map((a: any) => ({
      id: a.id, nickname: a.nickname, status: a.status,
      commissionPct: Number(a.commission_pct).toFixed(1),
      floatLimit: Number(a.float_limit).toFixed(2),
      floatUsed: Number(a.float_used).toFixed(2),
      floatLeft: (Number(a.float_limit) - Number(a.float_used)).toFixed(2),
      players: Number(a.players),
      minis: Number(a.minis),
      playersBalance: Number(a.players_balance).toFixed(2),
      housePl: Number(a.house_pl).toFixed(2),
      masterShare: Number(a.master_share).toFixed(2),
      adminShare: Number(a.admin_share).toFixed(2),
    }));
  }

  async createAdmin(p: { nickname: string; password: string; commissionPct: string; masterId: string }) {
    const nickname = String(p.nickname ?? '').trim();
    if (nickname.length < 3) throw new AgentError('Username must be at least 3 characters.');
    if (String(p.password ?? '').length < 6) throw new AgentError('Password must be at least 6 characters.');
    const commission = new Decimal(p.commissionPct || 0);
    if (commission.lt(0) || commission.gt(100)) throw new AgentError('Commission must be between 0 and 100.');

    const [taken] = await this.ds.query(`SELECT id FROM users WHERE nickname = ?`, [nickname]);
    if (taken) throw new AgentError('That username is already in use.');

    const id = randomUUID();
    const hash = await bcrypt.hash(p.password, 10);
    const maxBets = JSON.stringify(this.clampToCeiling((p as any).maxBets || {}, {}, false));
    await this.ds.query(
      `INSERT INTO users (id, nickname, password_hash, role, owner_id, commission_pct, currency, status, max_bets)
       VALUES (?,?,?, 'admin', ?, ?, 'PKR', 'active', ?)`,
      [id, nickname, hash, p.masterId, commission.toFixed(3), maxBets],
    );
    return { id, nickname };
  }

  async updateAdmin(id: string, p: { commissionPct?: string; status?: string }) {
    const fields: string[] = [];
    const args: any[] = [];
    if (p.commissionPct !== undefined) {
      const c = new Decimal(p.commissionPct);
      if (c.lt(0) || c.gt(100)) throw new AgentError('Commission must be between 0 and 100.');
      fields.push('commission_pct = ?'); args.push(c.toFixed(3));
    }
    if (p.status && ['active', 'suspended'].includes(p.status)) { fields.push('status = ?'); args.push(p.status); }
    if (!fields.length) throw new AgentError('Nothing to change.');
    await this.ds.query(`UPDATE users SET ${fields.join(', ')} WHERE id = ? AND role = 'admin'`, [...args, id]);
    return { id };
  }

  /** Change an admin's password. */
  async setAdminPassword(id: string, password: string) {
    if (String(password ?? '').length < 6) throw new AgentError('Password must be at least 6 characters.');
    const [admin] = await this.ds.query(`SELECT id FROM users WHERE id = ? AND role = 'admin'`, [id]);
    if (!admin) throw new AgentError('No such admin.');
    const hash = await bcrypt.hash(password, 10);
    await this.ds.query(`UPDATE users SET password_hash = ? WHERE id = ?`, [hash, id]);
    return { id };
  }

  /**
   * Permanently delete an admin. Their players are moved up to the master so no
   * account or balance is lost, and the win/loss history is left in the books so
   * the accounts still balance. Not reversible — the caller confirms first.
   */
  async deleteAdmin(id: string, masterId: string) {
    const [admin] = await this.ds.query(`SELECT id FROM users WHERE id = ? AND role = 'admin'`, [id]);
    if (!admin) throw new AgentError('No such admin.');
    let moved = 0;
    await this.ledger.inTx(async (qr: QueryRunner) => {
      const res = await qr.query(
        `UPDATE users SET owner_id = ? WHERE owner_id = ? AND role = 'player'`, [masterId, id],
      );
      moved = res.affectedRows ?? 0;
      // History rows keep the old admin_id so past sheets still add up.
      await qr.query(`DELETE FROM users WHERE id = ? AND role = 'admin'`, [id]);
    });
    return { id, playersMovedToMaster: moved };
  }

  /**
   * Fund an admin's float. Deposit and credit both raise the limit (deposit =
   * they paid you, credit = on loan — a label only). Deduct lowers it, but
   * never below what they've already handed out.
   */
  async fundAdmin(p: { masterId: string; adminId: string; kind: 'deposit' | 'credit' | 'deduct'; amount: string; note?: string }) {
    const amount = new Decimal(p.amount);
    if (amount.lte(0)) throw new AgentError('Enter an amount above zero.');
    const [admin] = await this.ds.query(
      `SELECT float_limit, float_used FROM users WHERE id = ? AND role = 'admin'`, [p.adminId],
    );
    if (!admin) throw new AgentError('No such admin.');

    let nextLimit: Decimal;
    if (p.kind === 'deduct') {
      nextLimit = new Decimal(admin.float_limit).minus(amount);
      if (nextLimit.lt(new Decimal(admin.float_used))) {
        throw new AgentError('Cannot deduct below what the admin has already credited to players.');
      }
    } else {
      nextLimit = new Decimal(admin.float_limit).plus(amount);
    }

    await this.ds.query(`UPDATE users SET float_limit = ? WHERE id = ?`, [nextLimit.toFixed(2), p.adminId]);
    await this.ds.query(
      `INSERT INTO agent_ledger (actor_id, subject_id, kind, amount, note) VALUES (?,?,?,?,?)`,
      [p.masterId, p.adminId, 'fund.' + p.kind, (p.kind === 'deduct' ? amount.negated() : amount).toFixed(2), p.note ?? null],
    );
    return {
      floatLimit: nextLimit.toFixed(2),
      floatUsed: Number(admin.float_used).toFixed(2),
      floatLeft: nextLimit.minus(admin.float_used).toFixed(2),
    };
  }

  // ---------------------------------------------------------- admin: players

  /** Players belonging to one admin (or, for the master, anyone). */
  async listPlayers(ownerId: string, opts: { search?: string; all?: boolean } = {}) {
    const where: string[] = [`p.role = 'player'`];
    const args: any[] = [];
    if (!opts.all) { where.push('p.owner_id = ?'); args.push(ownerId); }
    if (opts.search) {
      where.push('(p.nickname LIKE ? OR p.id = ?)');
      args.push('%' + opts.search + '%', opts.search);
    }
    const rows = await this.ds.query(
      `SELECT p.id, p.nickname, p.status, COALESCE(w.balance,0) AS balance, p.currency, p.created_at, p.owner_id,
              o.nickname AS owner_name,
              (SELECT COALESCE(SUM(house_pl),0) FROM agent_winloss w WHERE w.player_id = p.id) AS house_pl
         FROM users p LEFT JOIN users o ON o.id = p.owner_id
              LEFT JOIN wallet w ON w.user_id = p.id AND w.currency = p.currency
        WHERE ${where.join(' AND ')} ORDER BY p.created_at DESC LIMIT 300`,
      args,
    );
    return rows.map((r: any) => ({
      id: r.id, nickname: r.nickname, status: r.status,
      balance: Number(r.balance).toFixed(2), currency: r.currency,
      owner: r.owner_name, ownerId: r.owner_id,
      housePl: Number(r.house_pl).toFixed(2),
      createdAt: r.created_at,
    }));
  }

  async createPlayer(p: { ownerId: string; nickname: string; password: string }) {
    const nickname = String(p.nickname ?? '').trim();
    if (nickname.length < 3) throw new AgentError('Username must be at least 3 characters.');
    if (String(p.password ?? '').length < 6) throw new AgentError('Password must be at least 6 characters.');
    const [taken] = await this.ds.query(`SELECT id FROM users WHERE nickname = ?`, [nickname]);
    if (taken) throw new AgentError('That username is already in use.');

    const id = randomUUID();
    const hash = await bcrypt.hash(p.password, 10);
    // Clamp requested limits to the creator's ceiling. Admin and mini both have
    // a ceiling; only the master creates without one.
    const [creator] = await this.ds.query(`SELECT role, max_bets FROM users WHERE id = ?`, [p.ownerId]);
    const ceiling = this.parseMax(creator?.max_bets);
    const hasCeiling = creator?.role === 'admin' || creator?.role === 'mini';
    const maxBets = JSON.stringify(this.clampToCeiling((p as any).maxBets || {}, ceiling, hasCeiling));
    await this.ledger.inTx(async (qr: QueryRunner) => {
      await qr.query(
        `INSERT INTO users (id, nickname, password_hash, role, owner_id, currency, status, max_bets)
         VALUES (?,?,?, 'player', ?, 'PKR', 'active', ?)`,
        [id, nickname, hash, p.ownerId, maxBets],
      );
      await qr.query(`INSERT INTO wallet (user_id, currency, balance, status) VALUES (?, 'PKR', 0, 'active')`, [id]);
    });
    return { id, nickname };
  }

  /**
   * Move a player's balance. A positive delta credits the player and spends the
   * admin's float; a negative delta (withdrawal or correction) lowers the
   * player and does NOT return to the float.
   */
  async adjustPlayer(p: { actorId: string; actorRole: string; playerId: string; delta: string; note?: string }) {
    const delta = new Decimal(p.delta);
    if (delta.isZero()) throw new AgentError('Enter an amount.');

    const [player] = await this.ds.query(
      `SELECT p.id, p.owner_id, p.currency, COALESCE(w.balance,0) AS balance FROM users p LEFT JOIN wallet w ON w.user_id = p.id AND w.currency = p.currency WHERE p.id = ? AND p.role = 'player'`, [p.playerId],
    );
    if (!player) throw new AgentError('No such player.');

    // An admin may only touch their own players. The master may touch anyone.
    if (p.actorRole !== 'master' && player.owner_id !== p.actorId) {
      throw new AgentError('That player is not on your panel.');
    }

    // Float moves both ways for the owning admin: a credit spends it, a
    // withdrawal (negative delta) raises it by the amount taken. It has no
    // ceiling, so a big cash-out can push it above what was funded.
    // Both admins AND mini admins spend from their own float; only the master
    // has no float limit.
    const touchesFloat = p.actorRole === 'admin' || p.actorRole === 'mini';
    if (touchesFloat && delta.gt(0)) {
      const [holder] = await this.ds.query(`SELECT float_limit, float_used FROM users WHERE id = ?`, [p.actorId]);
      const left = new Decimal(holder.float_limit).minus(holder.float_used);
      if (delta.gt(left)) {
        throw new AgentError(`Not enough credit. You have ${left.toFixed(2)} left.`);
      }
    }
    if (delta.lt(0) && new Decimal(player.balance).plus(delta).lt(0)) {
      throw new AgentError('That would take the player below zero.');
    }

    await this.ledger.inTx(async (qr: QueryRunner) => {
      await this.ledger.move(qr, {
        userId: player.id,
        currency: player.currency,
        delta,
        reference: `agent:${delta.gt(0) ? 'credit' : 'debit'}:${Date.now()}`,
        meta: { by: p.actorId, note: p.note ?? null },
      });
      if (touchesFloat) {
        // float left = limit - used. Credit raises used (float down); a
        // withdrawal (delta<0) lowers used (float up). used may go negative,
        // which is how the float climbs past the original funding.
        await qr.query(`UPDATE users SET float_used = float_used + ? WHERE id = ?`, [delta.toFixed(2), p.actorId]);
      }
      await qr.query(
        `INSERT INTO agent_ledger (actor_id, subject_id, kind, amount, note) VALUES (?,?,?,?,?)`,
        [p.actorId, player.id, delta.gt(0) ? 'player.credit' : 'player.deduct', delta.toFixed(2), p.note ?? null],
      );
    });

    const [after] = await this.ds.query(`SELECT COALESCE(balance,0) AS balance FROM wallet WHERE user_id = ? AND currency = ?`, [player.id, player.currency]);
    return { playerId: player.id, balance: Number(after.balance).toFixed(2) };
  }

  /** Change a player's password. Admin may only touch their own. */
  async setPlayerPassword(p: { actorId: string; actorRole: string; playerId: string; password: string }) {
    if (String(p.password ?? '').length < 6) throw new AgentError('Password must be at least 6 characters.');
    const [pl] = await this.ds.query(`SELECT owner_id FROM users WHERE id = ? AND role = 'player'`, [p.playerId]);
    if (!pl) throw new AgentError('No such player.');
    if (p.actorRole !== 'master' && pl.owner_id !== p.actorId) throw new AgentError('That player is not on your panel.');
    const hash = await bcrypt.hash(p.password, 10);
    await this.ds.query(`UPDATE users SET password_hash = ? WHERE id = ?`, [hash, p.playerId]);
    return { id: p.playerId };
  }

  async setPlayerStatus(p: { actorId: string; actorRole: string; playerId: string; status: string }) {
    if (!['active', 'suspended'].includes(p.status)) throw new AgentError('Unknown status.');
    const [pl] = await this.ds.query(`SELECT owner_id FROM users WHERE id = ? AND role = 'player'`, [p.playerId]);
    if (!pl) throw new AgentError('No such player.');
    if (p.actorRole !== 'master' && pl.owner_id !== p.actorId) throw new AgentError('That player is not on your panel.');
    await this.ds.query(`UPDATE users SET status = ? WHERE id = ?`, [p.status, p.playerId]);
    return { id: p.playerId, status: p.status };
  }

  /**
   * Delete a player. Blocked if they still hold a balance, so no money is lost.
   * Their win/loss history stays in the books.
   */
  async deletePlayer(p: { actorId: string; actorRole: string; playerId: string }) {
    const [pl] = await this.ds.query(
      `SELECT p.owner_id, COALESCE(w.balance,0) AS balance FROM users p
         LEFT JOIN wallet w ON w.user_id = p.id AND w.currency = p.currency
        WHERE p.id = ? AND p.role = 'player'`, [p.playerId],
    );
    if (!pl) throw new AgentError('No such player.');
    if (p.actorRole !== 'master' && pl.owner_id !== p.actorId) throw new AgentError('That player is not on your panel.');
    if (new Decimal(pl.balance).gt(0)) throw new AgentError('Clear the player\'s balance to zero before deleting.');
    await this.ledger.inTx(async (qr: QueryRunner) => {
      await qr.query(`DELETE FROM wallet WHERE user_id = ?`, [p.playerId]);
      await qr.query(`DELETE FROM users WHERE id = ? AND role = 'player'`, [p.playerId]);
    });
    return { id: p.playerId };
  }

  /** Full detail on one player: deposits, withdrawals, win/loss by game. */
  async playerDetail(p: { actorId: string; actorRole: string; playerId: string }) {
    const [pl] = await this.ds.query(
      `SELECT p.id, p.nickname, p.status, p.owner_id, p.currency, p.created_at,
              COALESCE(w.balance,0) AS balance, o.nickname AS owner_name
         FROM users p LEFT JOIN wallet w ON w.user_id = p.id AND w.currency = p.currency
              LEFT JOIN users o ON o.id = p.owner_id
        WHERE p.id = ? AND p.role = 'player'`, [p.playerId],
    );
    if (!pl) throw new AgentError('No such player.');
    if (p.actorRole !== 'master' && pl.owner_id !== p.actorId) throw new AgentError('That player is not on your panel.');

    // Cash in and out from the agent ledger (what the admin credited / deducted).
    const [cash] = await this.ds.query(
      `SELECT COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END),0) AS deposited,
              COALESCE(SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END),0) AS withdrawn
         FROM agent_ledger WHERE subject_id = ? AND kind LIKE 'player.%'`, [p.playerId],
    );
    // Win/loss by game from attribution (house_pl is house's result; player's is the negative).
    const byGame = await this.ds.query(
      `SELECT game, COUNT(*) AS bets, COALESCE(SUM(stake),0) AS staked,
              COALESCE(SUM(house_pl),0) AS house_pl
         FROM agent_winloss WHERE player_id = ? GROUP BY game`, [p.playerId],
    );
    const [tot] = await this.ds.query(
      `SELECT COUNT(*) AS bets, COALESCE(SUM(stake),0) AS staked, COALESCE(SUM(house_pl),0) AS house_pl
         FROM agent_winloss WHERE player_id = ?`, [p.playerId],
    );
    // Recent activity, newest first.
    const recent = await this.ds.query(
      `SELECT game, stake, house_pl, settled_at FROM agent_winloss WHERE player_id = ?
        ORDER BY settled_at DESC LIMIT 30`, [p.playerId],
    );
    const fmt = (n: any) => Number(n).toFixed(2);
    return {
      player: {
        id: pl.id, nickname: pl.nickname, status: pl.status, currency: pl.currency,
        owner: pl.owner_name, balance: fmt(pl.balance), createdAt: pl.created_at,
      },
      cash: { deposited: fmt(cash.deposited), withdrawn: fmt(cash.withdrawn) },
      // player result = -house_pl: positive means the player is up.
      result: {
        bets: Number(tot.bets), staked: fmt(tot.staked),
        playerNet: fmt(-Number(tot.house_pl)), houseNet: fmt(tot.house_pl),
      },
      byGame: byGame.map((g: any) => ({ game: g.game, bets: Number(g.bets), staked: fmt(g.staked), playerNet: fmt(-Number(g.house_pl)) })),
      recent: recent.map((r: any) => ({ game: r.game, stake: fmt(r.stake), playerNet: fmt(-Number(r.house_pl)), at: r.settled_at })),
    };
  }

  // --------------------------------------------------- win/loss attribution

  /**
   * Record the house result of one settled bet against the player's admin.
   * Called by every game's settlement. Idempotent on (game, ref), so settling
   * the same bet twice never double-counts.
   *
   * housePl: positive = house won (player lost), negative = house paid out.
   */
  async recordResult(p: { playerId: string; game: string; ref: string; stake: string | number; housePl: string | number }) {
    const chain = await this.chainOf(p.playerId);
    if (!chain) return; // player with no owner (should not happen after migration)

    const housePl = new Decimal(p.housePl);
    // mini gets its whole-share; admin keeps its own share minus what the mini
    // took; master gets whatever is left. All from house_pl, signs preserved.
    const miniShare = housePl.mul(chain.miniPct).div(100);
    const adminShare = housePl.mul(chain.adminPct.minus(chain.miniPct)).div(100);
    const masterShare = housePl.minus(miniShare).minus(adminShare);

    await this.ds.query(
      `INSERT INTO agent_winloss
         (admin_id, mini_id, player_id, game, ref, stake, house_pl, commission_pct, admin_share, master_share, mini_share)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE house_pl = VALUES(house_pl), admin_share = VALUES(admin_share),
         master_share = VALUES(master_share), mini_share = VALUES(mini_share)`,
      [chain.adminId, chain.miniId, p.playerId, p.game, String(p.ref), new Decimal(p.stake).toFixed(2),
       housePl.toFixed(2), chain.adminPct.toFixed(3), adminShare.toFixed(2), masterShare.toFixed(2), miniShare.toFixed(2)],
    ).catch(() => { /* attribution must never break game settlement */ });
  }

  // ------------------------------------------------------------- the sheets

  /**
   * Win/loss sheet for one staff member, scoped by their role.
   *
   * - admin: rows where admin_id = them. Their share = admin_share. Up-line
   *   (what they owe the master) = master_share.
   * - mini: rows where mini_id = them. Their share = mini_share. Up-line (what
   *   they owe THEIR admin) = admin_share. They never see master_share.
   * - master viewing an admin: same as the admin's own view.
   */
  async winlossSheet(staffId: string, from?: string, to?: string, role: string = 'admin') {
    const isMini = role === 'mini';
    const idCol = isMini ? 'mini_id' : 'admin_id';
    const myShareCol = isMini ? 'mini_share' : 'admin_share';
    // What this person sends up-line, seen from their own level:
    //   mini  -> to its admin  = house_pl - mini_share  (the mini never sees the
    //            master; from its view the whole remainder goes up to the admin)
    //   admin -> to the master = master_share  (the stored top slice; a mini's
    //            cut on the same row is NOT part of what the admin sends up)
    const upShareExpr = isMini
      ? '(COALESCE(SUM(house_pl),0) - COALESCE(SUM(mini_share),0))'
      : 'COALESCE(SUM(master_share),0)';

    const where = [`${idCol} = ?`];
    const args: any[] = [staffId];
    if (from) { where.push('settled_at >= ?'); args.push(from + ' 00:00:00'); }
    if (to) { where.push('settled_at <= ?'); args.push(to + ' 23:59:59'); }

    const [totals] = await this.ds.query(
      `SELECT COUNT(*) AS bets, COALESCE(SUM(stake),0) AS staked,
              COALESCE(SUM(house_pl),0) AS house_pl,
              COALESCE(SUM(${myShareCol}),0) AS admin_share,
              ${upShareExpr} AS master_share
         FROM agent_winloss WHERE ${where.join(' AND ')}`,
      args,
    );
    const byGame = await this.ds.query(
      `SELECT game, COUNT(*) AS bets, COALESCE(SUM(stake),0) AS staked, COALESCE(SUM(house_pl),0) AS house_pl
         FROM agent_winloss WHERE ${where.join(' AND ')} GROUP BY game`,
      args,
    );
    const byPlayer = await this.ds.query(
      `SELECT w.player_id, u.nickname, COUNT(*) AS bets,
              COALESCE(SUM(w.stake),0) AS staked, COALESCE(SUM(w.house_pl),0) AS house_pl
         FROM agent_winloss w LEFT JOIN users u ON u.id = w.player_id
        WHERE ${where.join(' AND ')} GROUP BY w.player_id, u.nickname
        ORDER BY house_pl DESC LIMIT 200`,
      args,
    );

    const fmt = (n: any) => Number(n).toFixed(2);
    return {
      totals: {
        bets: Number(totals.bets),
        staked: fmt(totals.staked),
        housePl: fmt(totals.house_pl),
        adminShare: fmt(totals.admin_share),
        masterShare: fmt(totals.master_share),
      },
      byGame: byGame.map((g: any) => ({ game: g.game, bets: Number(g.bets), staked: fmt(g.staked), housePl: fmt(g.house_pl) })),
      byPlayer: byPlayer.map((p: any) => ({ playerId: p.player_id, player: p.nickname, bets: Number(p.bets), staked: fmt(p.staked), housePl: fmt(p.house_pl) })),
    };
  }

  // ------------------------------------------------------ per-owner suspend

  /** Events an admin/mini has suspended for their own players. */
  async suspendedEvents(ownerId: string): Promise<Set<string>> {
    const rows = await this.ds.query(
      `SELECT event_id FROM owner_event_suspend WHERE owner_id = ?`, [ownerId],
    ).catch(() => []);
    return new Set(rows.map((r: any) => r.event_id));
  }

  /** The sports list for an admin/mini: every event, flagged if they suspended it. */
  async ownerSportsList(ownerId: string) {
    const events = await this.ds.query(
      `SELECT e.id, e.sport, e.competition, e.home, e.away, e.start_time, e.status,
              (SELECT COUNT(*) FROM market m WHERE m.event_id = e.id) AS markets
         FROM sport_event e
        WHERE e.status <> 'settled'
        ORDER BY e.start_time ASC LIMIT 300`,
    ).catch(() => []);
    const mine = await this.suspendedEvents(ownerId);
    return events.map((e: any) => ({
      id: e.id, sport: e.sport, competition: e.competition,
      home: e.home, away: e.away, start: e.start_time,
      siteStatus: e.status,                    // master-level status
      markets: Number(e.markets),
      suspendedByMe: mine.has(e.id),           // this owner's own suspend
    }));
  }

  async setOwnerSuspend(p: { ownerId: string; eventId: string; suspend: boolean }) {
    if (p.suspend) {
      await this.ds.query(
        `INSERT IGNORE INTO owner_event_suspend (owner_id, event_id) VALUES (?, ?)`,
        [p.ownerId, p.eventId],
      );
    } else {
      await this.ds.query(
        `DELETE FROM owner_event_suspend WHERE owner_id = ? AND event_id = ?`,
        [p.ownerId, p.eventId],
      );
    }
    return { eventId: p.eventId, suspendedByMe: p.suspend };
  }

    /**
   * Account ledger for the Account Ledger screen.
   *
   * account = '_transactions' -> every deposit/withdraw this staff member made
   *           to their players (and, for master viewing an admin, that admin's).
   * account = '_share'        -> the share/commission entries per settled bet.
   * account = <playerId>      -> that one player's deposits and withdrawals.
   *
   * Rows carry a running balance from an opening balance, with a final total,
   * matching the ledger layout. Scope: an admin/mini sees their own subtree; the
   * master may pass viewAs (an admin/mini id) to see theirs.
   */
  async accountLedger(p: { viewerId: string; viewerRole: string; viewAs?: string; account: string; from?: string; to?: string }) {
    const ownerId = p.viewerRole === 'master' && p.viewAs ? p.viewAs : p.viewerId;
    const fromClause = p.from ? ` AND created_at >= ${this.ds.driver.escape(p.from + ' 00:00:00')}` : '';
    const toClause = p.to ? ` AND created_at <= ${this.ds.driver.escape(p.to + ' 23:59:59')}` : '';

    if (p.account === '_share') {
      // Share entries: each settled bet's share for this staff member.
      const isMini = (await this.userRow(ownerId))?.role === 'mini';
      const col = isMini ? 'mini_share' : 'admin_share';
      const idCol = isMini ? 'mini_id' : 'admin_id';
      const sf = p.from ? ` AND settled_at >= ${this.ds.driver.escape(p.from + ' 00:00:00')}` : '';
      const st = p.to ? ` AND settled_at <= ${this.ds.driver.escape(p.to + ' 23:59:59')}` : '';
      const rows = await this.ds.query(
        `SELECT w.settled_at AS at, u.nickname AS name, w.game, w.${col} AS amount
           FROM agent_winloss w LEFT JOIN users u ON u.id = w.player_id
          WHERE w.${idCol} = ?${sf}${st} ORDER BY w.settled_at DESC LIMIT 500`, [ownerId],
      );
      return this.runningLedger(rows.map((r: any) => ({
        at: r.at, name: r.name, credit: Number(r.amount) > 0 ? Number(r.amount) : 0,
        debit: Number(r.amount) < 0 ? -Number(r.amount) : 0, note: r.game,
      })));
    }

    // Transactions from the agent ledger (player credits/deducts).
    const where: string[] = [`al.kind LIKE 'player.%'`];
    const args: any[] = [];
    if (p.account && p.account !== '_transactions') {
      where.push('al.subject_id = ?'); args.push(p.account);
    } else {
      // all players under this owner (admin/mini)
      where.push(`al.subject_id IN (SELECT id FROM users WHERE owner_id = ? AND role = 'player')`);
      args.push(ownerId);
    }
    const rows = await this.ds.query(
      `SELECT al.created_at AS at, u.nickname AS name, al.kind, al.amount, al.note
         FROM agent_ledger al LEFT JOIN users u ON u.id = al.subject_id
        WHERE ${where.join(' AND ')}${fromClause}${toClause}
        ORDER BY al.created_at DESC LIMIT 500`, args,
    );
    return this.runningLedger(rows.map((r: any) => ({
      at: r.at, name: r.name,
      // a player.credit (positive) is money OUT to the player (deposit given);
      // a player.deduct (negative) is money IN from the player (withdraw taken).
      credit: Number(r.amount) > 0 ? Number(r.amount) : 0,
      debit: Number(r.amount) < 0 ? -Number(r.amount) : 0,
      note: r.note,
    })));
  }

  /** Turn dated rows (newest first) into an opening balance + running column. */
  private runningLedger(rows: { at: any; name: string; credit: number; debit: number; note?: string }[]) {
    const chrono = [...rows].reverse(); // oldest first for the running sum
    let bal = 0;
    const out = chrono.map((r) => {
      bal += r.credit - r.debit;
      return {
        at: r.at, name: r.name,
        deposit: r.credit ? r.credit.toFixed(2) : '',
        withdraw: r.debit ? r.debit.toFixed(2) : '',
        balance: bal.toFixed(2), note: r.note ?? '',
      };
    });
    out.reverse(); // newest first for display
    const totalDep = chrono.reduce((s, r) => s + r.credit, 0);
    const totalWd = chrono.reduce((s, r) => s + r.debit, 0);
    return {
      opening: '0.00',
      rows: out,
      totals: { deposit: totalDep.toFixed(2), withdraw: totalWd.toFixed(2), balance: bal.toFixed(2) },
    };
  }

  /** Accounts available in the ledger dropdown for this viewer. */
  async ledgerAccounts(p: { viewerId: string; viewerRole: string; viewAs?: string }) {
    const ownerId = p.viewerRole === 'master' && p.viewAs ? p.viewAs : p.viewerId;
    const players = await this.ds.query(
      `SELECT id, nickname FROM users WHERE owner_id = ? AND role = 'player' ORDER BY nickname`, [ownerId],
    );
    return {
      special: [
        { id: '_share', label: '_Share' },
        { id: '_transactions', label: '_Transactions' },
      ],
      players: players.map((p: any) => ({ id: p.id, nickname: p.nickname })),
    };
  }

  /** Float and funding record for one admin. */
  async floatSheet(adminId: string) {
    const [admin] = await this.ds.query(
      `SELECT float_limit, float_used, commission_pct FROM users WHERE id = ? AND role IN ('admin','mini')`, [adminId],
    );
    if (!admin) throw new AgentError('No such account.');
    const funding = await this.ds.query(
      `SELECT kind, amount, note, created_at FROM agent_ledger
        WHERE subject_id = ? AND (kind LIKE 'fund.%' OR kind LIKE 'minifund.%') ORDER BY created_at DESC LIMIT 100`,
      [adminId],
    );
    return {
      floatLimit: Number(admin.float_limit).toFixed(2),
      floatUsed: Number(admin.float_used).toFixed(2),
      floatLeft: (Number(admin.float_limit) - Number(admin.float_used)).toFixed(2),
      commissionPct: Number(admin.commission_pct).toFixed(1),
      funding: funding.map((f: any) => ({
        kind: f.kind.replace('fund.', ''), amount: Number(f.amount).toFixed(2), note: f.note, at: f.created_at,
      })),
    };
  }
}
