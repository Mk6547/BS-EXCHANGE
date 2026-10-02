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
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SicBoController = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("typeorm");
const jwt_auth_guard_1 = require("../auth/jwt-auth.guard");
const sicbo_service_1 = require("./sicbo.service");
let SicBoController = class SicBoController {
    ds;
    sb;
    constructor(ds, sb) {
        this.ds = ds;
        this.sb = sb;
    }
    state(req) { return this.sb.state(req.user?.id); }
    mine(req) { return this.sb.state(req.user.id); }
    async bet(req, b) {
        const [u] = await this.ds.query(`SELECT currency FROM users WHERE id=?`, [req.user.id]);
        try {
            return await this.sb.placeBet({ userId: req.user.id, currency: u?.currency ?? 'PKR', market: b?.market, selection: b?.selection, stake: String(b?.stake ?? '') });
        }
        catch (e) {
            if (e instanceof sicbo_service_1.SbError)
                throw new common_1.BadRequestException({ message: e.message });
            throw new common_1.BadRequestException({ message: e?.message ?? 'The bet could not be placed.' });
        }
    }
    async myBets(req, limit) {
        return { bets: await this.sb.myRecentBets(req.user.id, Number(limit ?? 30)) };
    }
};
exports.SicBoController = SicBoController;
__decorate([
    (0, common_1.Get)('state'),
    __param(0, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], SicBoController.prototype, "state", null);
__decorate([
    (0, common_1.Get)('state/mine'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    __param(0, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], SicBoController.prototype, "mine", null);
__decorate([
    (0, common_1.Post)('bets'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], SicBoController.prototype, "bet", null);
__decorate([
    (0, common_1.Get)('bets'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Query)('limit')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], SicBoController.prototype, "myBets", null);
exports.SicBoController = SicBoController = __decorate([
    (0, common_1.Controller)('sicbo'),
    __metadata("design:paramtypes", [typeorm_1.DataSource, sicbo_service_1.SicBoService])
], SicBoController);
