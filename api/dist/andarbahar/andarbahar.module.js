"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AndarBaharModule = void 0;
const common_1 = require("@nestjs/common");
const jwt_1 = require("@nestjs/jwt");
const config_1 = require("@nestjs/config");
const andarbahar_service_1 = require("./andarbahar.service");
const andarbahar_controller_1 = require("./andarbahar.controller");
const admin_andarbahar_controller_1 = require("./admin-andarbahar.controller");
const ledger_service_1 = require("../platform/ledger.service");
const audit_service_1 = require("../platform/audit.service");
let AndarBaharModule = class AndarBaharModule {
};
exports.AndarBaharModule = AndarBaharModule;
exports.AndarBaharModule = AndarBaharModule = __decorate([
    (0, common_1.Module)({
        imports: [
            jwt_1.JwtModule.registerAsync({
                imports: [config_1.ConfigModule], inject: [config_1.ConfigService],
                useFactory: (c) => ({ secret: c.getOrThrow('JWT_SECRET'), signOptions: { expiresIn: c.get('JWT_TTL') ?? '7d' } }),
            }),
        ],
        controllers: [andarbahar_controller_1.AndarBaharController, admin_andarbahar_controller_1.AdminAndarBaharController],
        providers: [andarbahar_service_1.AndarBaharService, ledger_service_1.LedgerService, audit_service_1.AuditService],
        exports: [andarbahar_service_1.AndarBaharService],
    })
], AndarBaharModule);
