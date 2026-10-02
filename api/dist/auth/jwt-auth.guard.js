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
Object.defineProperty(exports, "__esModule", { value: true });
exports.AdminGuard = exports.JwtAuthGuard = void 0;
const common_1 = require("@nestjs/common");
const jwt_1 = require("@nestjs/jwt");
/**
 * Reads the bearer token and puts the player on req.user, which is what
 * /launch has been assuming existed all along.
 */
let JwtAuthGuard = class JwtAuthGuard {
    jwt;
    constructor(jwt) {
        this.jwt = jwt;
    }
    canActivate(ctx) {
        const req = ctx.switchToHttp().getRequest();
        const header = req.headers?.authorization ?? '';
        const token = header.startsWith('Bearer ') ? header.slice(7) : null;
        if (!token)
            throw new common_1.UnauthorizedException('Sign in to continue.');
        try {
            const claims = this.jwt.verify(token);
            req.user = { id: claims.sub, nickname: claims.nickname, role: claims.role };
            return true;
        }
        catch {
            throw new common_1.UnauthorizedException('Your session has expired. Sign in again.');
        }
    }
};
exports.JwtAuthGuard = JwtAuthGuard;
exports.JwtAuthGuard = JwtAuthGuard = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [jwt_1.JwtService])
], JwtAuthGuard);
/**
 * Layered on top of JwtAuthGuard for routes that move money or change config.
 *
 * Throws 403, not 401. The distinction matters: 401 means "your session is no
 * longer valid, sign in again", and clients act on it by clearing the token.
 * A signed-in player who simply is not an admin has a perfectly valid session,
 * so answering 401 would send them round a sign-in loop forever.
 */
let AdminGuard = class AdminGuard {
    canActivate(ctx) {
        const req = ctx.switchToHttp().getRequest();
        if (req.user?.role !== 'admin' && req.user?.role !== 'master' && req.user?.role !== 'mini') {
            throw new common_1.ForbiddenException('This account does not have administrator access.');
        }
        return true;
    }
};
exports.AdminGuard = AdminGuard;
exports.AdminGuard = AdminGuard = __decorate([
    (0, common_1.Injectable)()
], AdminGuard);
