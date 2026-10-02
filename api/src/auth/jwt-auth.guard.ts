import {
  CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

/**
 * Reads the bearer token and puts the player on req.user, which is what
 * /launch has been assuming existed all along.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const header: string = req.headers?.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw new UnauthorizedException('Sign in to continue.');

    try {
      const claims = this.jwt.verify(token);
      req.user = { id: claims.sub, nickname: claims.nickname, role: claims.role };
      return true;
    } catch {
      throw new UnauthorizedException('Your session has expired. Sign in again.');
    }
  }
}

/**
 * Layered on top of JwtAuthGuard for routes that move money or change config.
 *
 * Throws 403, not 401. The distinction matters: 401 means "your session is no
 * longer valid, sign in again", and clients act on it by clearing the token.
 * A signed-in player who simply is not an admin has a perfectly valid session,
 * so answering 401 would send them round a sign-in loop forever.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    if (req.user?.role !== 'admin' && req.user?.role !== 'master' && req.user?.role !== 'mini') {
      throw new ForbiddenException('This account does not have administrator access.');
    }
    return true;
  }
}