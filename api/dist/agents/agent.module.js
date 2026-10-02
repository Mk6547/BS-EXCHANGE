"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AgentModule = void 0;
const common_1 = require("@nestjs/common");
const jwt_1 = require("@nestjs/jwt");
const config_1 = require("@nestjs/config");
const agent_service_1 = require("./agent.service");
const winloss_sync_service_1 = require("./winloss-sync.service");
const agent_controller_1 = require("./agent.controller");
const ledger_service_1 = require("../platform/ledger.service");
const audit_service_1 = require("../platform/audit.service");
/**
 * The master / admin / player hierarchy. AgentService is exported so each
 * game's settlement can call recordResult() to attribute win/loss to the
 * player's admin.
 */
let AgentModule = class AgentModule {
};
exports.AgentModule = AgentModule;
exports.AgentModule = AgentModule = __decorate([
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
        controllers: [agent_controller_1.AgentController],
        providers: [agent_service_1.AgentService, winloss_sync_service_1.WinlossSyncService, ledger_service_1.LedgerService, audit_service_1.AuditService],
        exports: [agent_service_1.AgentService],
    })
], AgentModule);
