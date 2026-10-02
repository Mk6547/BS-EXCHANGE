"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.InoutModule = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const inout_controller_1 = require("./inout.controller");
// TEMPORARY — remove this import and the controller entry below before go-live.
const inout_debug_controller_1 = require("./inout-debug.controller");
const inout_webhook_service_1 = require("./inout-webhook.service");
const inout_session_service_1 = require("./inout-session.service");
const inout_launch_service_1 = require("./inout-launch.service");
const inout_bonus_service_1 = require("./inout-bonus.service");
let InoutModule = class InoutModule {
};
exports.InoutModule = InoutModule;
exports.InoutModule = InoutModule = __decorate([
    (0, common_1.Module)({
        imports: [config_1.ConfigModule],
        controllers: [inout_controller_1.InoutController, inout_debug_controller_1.InoutDebugController],
        providers: [inout_webhook_service_1.InoutWebhookService, inout_session_service_1.InoutSessionService, inout_launch_service_1.InoutLaunchService, inout_bonus_service_1.InoutBonusService],
        exports: [inout_launch_service_1.InoutLaunchService, inout_bonus_service_1.InoutBonusService],
    })
], InoutModule);
