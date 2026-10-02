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
var InoutBonusService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.InoutBonusService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const typeorm_1 = require("typeorm");
const inout_constants_1 = require("./inout.constants");
const inout_ids_util_1 = require("./util/inout-ids.util");
let InoutBonusService = InoutBonusService_1 = class InoutBonusService {
    ds;
    log = new common_1.Logger(InoutBonusService_1.name);
    operatorId;
    signature;
    apiBase;
    constructor(ds, config) {
        this.ds = ds;
        const aggregatorId = config.getOrThrow('INOUT_AGGREGATOR_ID');
        const subId = config.getOrThrow('INOUT_SUB_ID');
        const secretKey = config.getOrThrow('INOUT_SIGNATURE_KEY');
        // Bonus spec 2: the :operatorId path segment is the derived subOperatorId,
        // not the aggregatorId.
        this.operatorId = config.get('INOUT_SUB_OPERATOR_ID') ?? (0, inout_ids_util_1.subOperatorId)(aggregatorId, subId);
        this.apiBase =
            (config.get('INOUT_API_BASE') ?? inout_constants_1.INOUT_API_BASE_DEFAULT).replace(/\/$/, '') +
                inout_constants_1.INOUT_OPERATOR_API_PATH;
        // Bonus spec 1: constant per operator, so compute it once.
        this.signature = (0, inout_ids_util_1.operatorApiSignature)(this.operatorId, secretKey);
        this.log.log(`inout operator api ready for subOperatorId ${this.operatorId}`);
    }
    /**
     * Record the grant locally *before* calling the provider.
     *
     * The settlement webhook can credit real money, and it will only be honoured
     * if the bonusId matches a row here. Writing the row second would leave a
     * window where a settlement arrives for a bonus we have no record of. If the
     * remote call fails we roll our row back, since no bonus exists to settle.
     */
    async create(input, opts = {}) {
        const betAmount = firstBetAmount(input.freebetConfig);
        await this.ds.query(`INSERT INTO inout_bonus
         (bonus_id, user_id, currency, game_modes, type, bet_amount, bonus_count,
          expires_at, hide_from_stat, config)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
            input.bonusId,
            input.userId,
            input.currency,
            JSON.stringify(input.gameModes),
            input.type,
            betAmount,
            Number(input.freebetConfig.count),
            new Date(input.expiresAt),
            opts.hideFromStat ? 1 : 0,
            JSON.stringify(input.freebetConfig),
        ]);
        try {
            return await this.call('POST', `/bonuses/${this.operatorId}`, input);
        }
        catch (err) {
            await this.ds.query(`DELETE FROM inout_bonus WHERE bonus_id = ?`, [input.bonusId]);
            throw err;
        }
    }
    async list(filter) {
        const qs = new URLSearchParams();
        if (filter.userId)
            qs.set('filter[userId]', filter.userId);
        if (filter.gameModes)
            qs.set('filter[gameModes]', filter.gameModes);
        filter.currency?.forEach((c) => qs.append('filter[currency[]]', c));
        filter.status?.forEach((s) => qs.append('filter[status]', s));
        qs.set('pageable[page]', String(filter.page ?? 1));
        qs.set('pageable[limit]', String(filter.limit ?? 20));
        return this.call('GET', `/bonuses/${this.operatorId}?${qs}`);
    }
    async view(bonusId) {
        return this.call('GET', `/bonuses/${this.operatorId}/${bonusId}`);
    }
    async cancel(bonusId) {
        const out = await this.call('DELETE', `/bonuses/${this.operatorId}/${bonusId}`);
        await this.ds.query(`UPDATE inout_bonus SET status = 'CANCELLED' WHERE bonus_id = ? AND settled_at IS NULL`, [bonusId]);
        return out;
    }
    async call(method, path, body) {
        const res = await fetch(`${this.apiBase}${path}`, {
            method,
            headers: {
                'X-REQUEST-SIGN': this.signature,
                ...(body ? { 'Content-Type': 'application/json' } : {}),
            },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(15_000),
        });
        const text = await res.text();
        if (!res.ok) {
            this.log.error(`${method} ${path} -> ${res.status} ${text}`);
            throw new Error(`inout bonus api ${res.status}`);
        }
        return text ? JSON.parse(text) : null;
    }
};
exports.InoutBonusService = InoutBonusService;
exports.InoutBonusService = InoutBonusService = InoutBonusService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [typeorm_1.DataSource,
        config_1.ConfigService])
], InoutBonusService);
/** Every *Config variant carries betAmount; pull whichever one is present. */
function firstBetAmount(cfg) {
    for (const [key, value] of Object.entries(cfg)) {
        if (key === 'count' || !value || typeof value !== 'object')
            continue;
        const amount = value.betAmount;
        if (amount)
            return amount;
    }
    return null;
}
