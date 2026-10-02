"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.InoutExceptionFilter = exports.InoutRejection = void 0;
const common_1 = require("@nestjs/common");
const inout_constants_1 = require("../inout.constants");
/** Throw this anywhere in the webhook path to answer with a specific code. */
class InoutRejection extends Error {
    code;
    reason;
    playerMessage;
    constructor(code, reason, playerMessage) {
        super(reason ?? code);
        this.code = code;
        this.reason = reason;
        this.playerMessage = playerMessage;
    }
}
exports.InoutRejection = InoutRejection;
/**
 * Spec 2.1: "The expected HTTP code for a successful response is 200. Any other
 * code will be interpreted as an error even if the code field in the response is OK."
 *
 * So the HTTP layer must never leak a 4xx/5xx — every outcome, success or
 * failure, goes back as 200 with the outcome in the body. An uncaught crash
 * becomes TEMPORARY_ERROR, which is the retryable code: for `bet` the provider
 * auto-rolls back (2.51), for withdraw/rollback it resends with backoff (2.52).
 * That is exactly the behaviour we want when we don't know what happened.
 */
let InoutExceptionFilter = class InoutExceptionFilter {
    log = new common_1.Logger('InoutWebhook');
    catch(err, host) {
        const res = host.switchToHttp().getResponse();
        const req = host.switchToHttp().getRequest();
        if (err instanceof InoutRejection) {
            // console.error, not Logger.warn: under Passenger only stderr is captured
            // to stderr.log, and a rejection nobody can see is a rejection nobody can
            // debug. Remove once proper logging is in place.
            console.error(`[inout] REJECTED ${err.code} :: ${err.reason ?? 'no reason'} :: ` +
                `ip=${req?.ip} xff=${req?.headers?.['x-forwarded-for'] ?? '-'} ` +
                `action=${req?.body?.action ?? '-'}`);
            return res.status(200).json({
                code: err.code,
                message: err.playerMessage ?? inout_constants_1.INOUT_DEFAULT_MESSAGE[err.code],
            });
        }
        console.error(`[inout] UNHANDLED action=${req?.body?.action ?? '-'} :: ${err?.message}`, err?.stack);
        return res.status(200).json({
            code: inout_constants_1.InoutCode.TEMPORARY_ERROR,
            message: inout_constants_1.INOUT_DEFAULT_MESSAGE[inout_constants_1.InoutCode.TEMPORARY_ERROR],
        });
    }
};
exports.InoutExceptionFilter = InoutExceptionFilter;
exports.InoutExceptionFilter = InoutExceptionFilter = __decorate([
    (0, common_1.Catch)()
], InoutExceptionFilter);
