"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MasterGuard = exports.StaffGuard = void 0;
const common_1 = require("@nestjs/common");
/**
 * Master or admin may pass. Use this on the shared admin panel routes so both
 * the master and ordinary admins reach them; each controller then scopes what
 * it returns by req.user.role and req.user.id.
 *
 * The original AdminGuard checks role === 'admin' only, which would lock the
 * master out after the migration promotes them. These guards live alongside it.
 */
let StaffGuard = class StaffGuard {
    canActivate(ctx) {
        const role = ctx.switchToHttp().getRequest().user?.role;
        if (role !== 'master' && role !== 'admin' && role !== 'mini') {
            throw new common_1.ForbiddenException('This account does not have staff access.');
        }
        return true;
    }
};
exports.StaffGuard = StaffGuard;
exports.StaffGuard = StaffGuard = __decorate([
    (0, common_1.Injectable)()
], StaffGuard);
/** Master only — creating admins, funding floats, site settings, game config. */
let MasterGuard = class MasterGuard {
    canActivate(ctx) {
        if (ctx.switchToHttp().getRequest().user?.role !== 'master') {
            throw new common_1.ForbiddenException('Only the master admin can do this.');
        }
        return true;
    }
};
exports.MasterGuard = MasterGuard;
exports.MasterGuard = MasterGuard = __decorate([
    (0, common_1.Injectable)()
], MasterGuard);
