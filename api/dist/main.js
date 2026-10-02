"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("reflect-metadata");
const core_1 = require("@nestjs/core");
const app_module_1 = require("./app.module");
async function bootstrap() {
    // rawBody: true is required — the HMAC in backend spec 2.2 is computed over
    // the body in its original form, so we need the exact bytes received, not a
    // re-serialised object.
    const app = await core_1.NestFactory.create(app_module_1.AppModule, { rawBody: true });
    // Must equal the number of proxies actually in front of Node. On cPanel,
    // Apache/Passenger is one; add one more if Cloudflare is proxying. Get this
    // wrong and the IP allowlist either blocks the provider or trusts a spoofed
    // X-Forwarded-For.
    const httpAdapter = app.getHttpAdapter().getInstance();
    httpAdapter.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS ?? 1));
    // The lobby is served from bsexchange.live while this API answers on
    // api.bsexchange.live, so the browser treats every call as cross-origin.
    // Listing origins explicitly rather than using '*' keeps credentialed
    // requests possible once real login exists.
    app.enableCors({
        origin: (process.env.CORS_ORIGINS ?? 'https://bsexchange.live,https://www.bsexchange.live,https://admin.bsexchange.live')
            .split(',')
            .map((o) => o.trim())
            .filter(Boolean),
        // The admin panel needs PUT and DELETE for payment methods, banners,
        // promotions and settings. With only GET and POST allowed, the browser
        // blocks those calls at the preflight and the admin screens fail.
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization'],
        credentials: true,
    });
    await app.listen(Number(process.env.PORT ?? 3000));
}
bootstrap();
