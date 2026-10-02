"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TeenPattiModule = void 0;
const common_1 = require("@nestjs/common");
const jwt_1 = require("@nestjs/jwt");
const config_1 = require("@nestjs/config");
const teenpatti_service_1 = require("./teenpatti.service");
const teenpatti_controller_1 = require("./teenpatti.controller");
const admin_teenpatti_controller_1 = require("./admin-teenpatti.controller");
const ledger_service_1 = require("../platform/ledger.service");
const audit_service_1 = require("../platform/audit.service");
/** Teen Patti 20-20. Shares the wallet with sports, the wheel and InOut. */
let TeenPattiModule = class TeenPattiModule {
};
exports.TeenPattiModule = TeenPattiModule;
exports.TeenPattiModule = TeenPattiModule = __decorate([
    (0, common_1.Module)({
        imports: [
            jwt_1.JwtModule.registerAsync({
                imports: [config_1.ConfigModule],
                inject: [config_1.ConfigService],
                useFactory: (config) => ({
                    secret: config.getOrThrow('JWT_SECRET'),
                    signOptions: { expiresIn: config.get('JWT_TTL') ?? '7d' },
                }),
            }),
        ],
        controllers: [teenpatti_controller_1.TeenPattiController, admin_teenpatti_controller_1.AdminTeenPattiController],
        providers: [teenpatti_service_1.TeenPattiService, ledger_service_1.LedgerService, audit_service_1.AuditService],
        exports: [teenpatti_service_1.TeenPattiService],
    })
], TeenPattiModule);
