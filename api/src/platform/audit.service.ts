import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

/**
 * Every sensitive admin action is recorded here.
 *
 * Writes are best-effort and never block the action itself — a failed audit
 * write must not roll back an approved withdrawal — but failures are logged
 * loudly, because a silently empty audit trail is worse than no audit trail.
 */
@Injectable()
export class AuditService {
  private readonly log = new Logger(AuditService.name);

  constructor(private readonly ds: DataSource) {}

  async record(p: {
    adminId: string;
    action: string;
    target?: string;
    metadata?: object;
    ip?: string;
  }) {
    try {
      await this.ds.query(
        `INSERT INTO admin_audit_log (admin_id, action, target, metadata, ip) VALUES (?, ?, ?, ?, ?)`,
        [p.adminId, p.action, p.target ?? null, JSON.stringify(p.metadata ?? {}), p.ip ?? null],
      );
    } catch (err: any) {
      this.log.error(`audit write failed for ${p.action}: ${err?.message}`);
    }
  }
}
