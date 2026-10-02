import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { InoutCode } from '../inout.constants';
import { InoutRejection } from '../filters/inout-exception.filter';

/**
 * Spec 2.2 — X-REQUEST-SIGN is HMAC-SHA256(rawBody, signatureKey), hex.
 *
 * The signature is over the body *in its original form*, so we must hash the
 * exact bytes received. Bootstrap Nest with `{ rawBody: true }` (see main.ts)
 * — hashing JSON.stringify(req.body) will fail on key order and whitespace.
 *
 * The legacy `signature` header exists only for backward compatibility with the
 * provider's older algorithm; we do not accept it.
 */
@Injectable()
export class InoutSignatureGuard implements CanActivate {
  private readonly log = new Logger(InoutSignatureGuard.name);
  private readonly key: string;

  constructor(config: ConfigService) {
    this.key = config.getOrThrow<string>('INOUT_SIGNATURE_KEY');
  }

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const provided = req.header('X-REQUEST-SIGN');
    const raw: Buffer | undefined = req.rawBody;

    if (!provided || !raw?.length) {
      throw new InoutRejection(InoutCode.INVALID_TOKEN, 'missing signature or body');
    }

    const expected = createHmac('sha256', this.key).update(raw).digest('hex');
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(provided.trim().toLowerCase(), 'utf8');

    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      this.log.warn('signature mismatch on inout webhook');
      throw new InoutRejection(InoutCode.INVALID_TOKEN, 'bad signature');
    }
    return true;
  }
}
