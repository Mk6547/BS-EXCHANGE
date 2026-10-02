import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { INOUT_IP_ALLOWLIST } from '../inout.constants';
import { InoutRejection } from '../filters/inout-exception.filter';
import { InoutCode } from '../inout.constants';

/**
 * Only the provider's published egress IPs may reach the webhook.
 *
 * IMPORTANT: this reads the socket IP, or the *left-most untrusted* hop from
 * X-Forwarded-For. Set `app.set('trust proxy', <n>)` to the exact number of
 * proxies in front of Nest (Cloudflare + nginx = 2). Getting this wrong
 * either blocks the provider or lets anyone spoof the header.
 */
@Injectable()
export class InoutIpGuard implements CanActivate {
  private readonly log = new Logger(InoutIpGuard.name);
  private readonly allowed: Set<string>;

  constructor(config: ConfigService) {
    const env = config.get<string>('INOUT_ENV', 'prod');
    const extra = (config.get<string>('INOUT_EXTRA_IPS') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    this.allowed = new Set([...(INOUT_IP_ALLOWLIST[env] ?? []), ...extra]);
  }

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const ip = normalise(req.ip ?? req.socket?.remoteAddress ?? '');
    if (!this.allowed.has(ip)) {
      this.log.warn(`rejected webhook from ${ip}`);
      throw new InoutRejection(InoutCode.INVALID_TOKEN, 'source not allowlisted');
    }
    return true;
  }
}

function normalise(ip: string): string {
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}
