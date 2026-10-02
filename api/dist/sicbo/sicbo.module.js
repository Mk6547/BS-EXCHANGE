"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SicBoModule = void 0;
const common_1 = require("@nestjs/common");
const jwt_1 = require("@nestjs/jwt");
const config_1 = require("@nestjs/config");
const sicbo_service_1 = require("./sicbo.service");
const sicbo_controller_1 = require("./sicbo.controller");
const admin_sicbo_controller_1 = require("./admin-sicbo.controller");
const ledger_service_1 = require("../platform/ledger.service");
const audit_service_1 = require("../platform/audit.service");
let SicBoModule = class SicBoModule {
};
exports.SicBoModule = SicBoModule;
exports.SicBoModule = SicBoModule = __decorate([
    (0, common_1.Module)({
        imports: [jwt_1.JwtModule.registerAsync({ imports: [config_1.ConfigModule], inject: [config_1.ConfigService], useFactory: (c) => ({ secret: c.getOrThrow('JWT_SECRET'), signOptions: { expiresIn: c.get('JWT_TTL') ?? '7d' } }) })],
        controllers: [sicbo_controller_1.SicBoController, admin_sicbo_controller_1.AdminSicBoController],
        providers: [sicbo_service_1.SicBoService, ledger_service_1.LedgerService, audit_service_1.AuditService],
        exports: [sicbo_service_1.SicBoService],
    })
], SicBoModule);
