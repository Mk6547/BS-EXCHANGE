import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';

/**
 * Master or admin may pass. Use this on the shared admin panel routes so both
 * the master and ordinary admins reach them; each controller then scopes what
 * it returns by req.user.role and req.user.id.
 *
 * The original AdminGuard checks role === 'admin' only, which would lock the
 * master out after the migration promotes them. These guards live alongside it.
 */
@Injectable()
export class StaffGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const role = ctx.switchToHttp().getRequest().user?.role;
    if (role !== 'master' && role !== 'admin' && role !== 'mini') {
      throw new ForbiddenException('This account does not have staff access.');
    }
    return true;
  }
}

/** Master only — creating admins, funding floats, site settings, game config. */
@Injectable()
export class MasterGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    if (ctx.switchToHttp().getRequest().user?.role !== 'master') {
      throw new ForbiddenException('Only the master admin can do this.');
    }
    return true;
  }
}
