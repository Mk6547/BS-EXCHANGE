"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PlatformModule = void 0;
const common_1 = require("@nestjs/common");
const admin_controller_1 = require("./admin.controller");
const admin_config_controller_1 = require("./admin-config.controller");
const content_controller_1 = require("./content.controller");
const payments_controller_1 = require("./payments.controller");
const audit_service_1 = require("./audit.service");
const ledger_service_1 = require("./ledger.service");
let PlatformModule = class PlatformModule {
};
exports.PlatformModule = PlatformModule;
exports.PlatformModule = PlatformModule = __decorate([
    (0, common_1.Module)({
        controllers: [content_controller_1.ContentController, payments_controller_1.PaymentsController, admin_controller_1.AdminController, admin_config_controller_1.AdminConfigController],
        providers: [ledger_service_1.LedgerService, audit_service_1.AuditService],
        exports: [ledger_service_1.LedgerService, audit_service_1.AuditService],
    })
], PlatformModule);
