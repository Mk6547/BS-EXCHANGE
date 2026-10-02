"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppModule = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const typeorm_1 = require("@nestjs/typeorm");
const inout_module_1 = require("./inout/inout.module");
const auth_module_1 = require("./auth/auth.module");
const wallet_module_1 = require("./wallet/wallet.module");
const platform_module_1 = require("./platform/platform.module");
const sports_module_1 = require("./sports/sports.module");
const wheel_module_1 = require("./wheel/wheel.module");
const teenpatti_module_1 = require("./teenpatti/teenpatti.module");
const andarbahar_module_1 = require("./andarbahar/andarbahar.module");
const sicbo_module_1 = require("./sicbo/sicbo.module");
const agent_module_1 = require("./agents/agent.module");
let AppModule = class AppModule {
};
exports.AppModule = AppModule;
exports.AppModule = AppModule = __decorate([
    (0, common_1.Module)({
        imports: [
            config_1.ConfigModule.forRoot({ isGlobal: true }),
            // Every query in this project is hand-written SQL, so there are no entities
            // and synchronize stays off — the schema is owned by the files in sql/.
            typeorm_1.TypeOrmModule.forRootAsync({
                inject: [config_1.ConfigService],
                // The explicit return type matters: without it TypeScript widens the
                // object and rejects it, because ConfigService.get() is string|undefined
                // under strictNullChecks.
                useFactory: (config) => ({
                    type: 'mysql',
                    host: config.get('DB_HOST') ?? 'localhost',
                    port: Number(config.get('DB_PORT') ?? 3306),
                    username: config.getOrThrow('DB_USER'),
                    password: config.getOrThrow('DB_PASS'),
                    database: config.getOrThrow('DB_NAME'),
                    entities: [],
                    synchronize: false,
                    // Keep the pool small: shared hosting caps concurrent MySQL connections,
                    // and exhausting them makes webhooks time out rather than fail cleanly.
                    extra: { connectionLimit: 5 },
                    // DECIMAL columns must arrive as strings, or JS floats would silently
                    // corrupt balances.
                    supportBigNumbers: true,
                    bigNumberStrings: true,
                }),
            }),
            auth_module_1.AuthModule,
            inout_module_1.InoutModule,
            wallet_module_1.WalletModule,
            platform_module_1.PlatformModule,
            sports_module_1.SportsModule,
            wheel_module_1.WheelModule,
            teenpatti_module_1.TeenPattiModule,
            andarbahar_module_1.AndarBaharModule,
            sicbo_module_1.SicBoModule,
            agent_module_1.AgentModule,
        ],
    })
], AppModule);
