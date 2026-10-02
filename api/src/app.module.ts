import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule, TypeOrmModuleOptions } from '@nestjs/typeorm';
import { InoutModule } from './inout/inout.module';
import { AuthModule } from './auth/auth.module';
import { WalletModule } from './wallet/wallet.module';
import { PlatformModule } from './platform/platform.module';
import { SportsModule } from './sports/sports.module';
import { WheelModule } from './wheel/wheel.module';
import { TeenPattiModule } from './teenpatti/teenpatti.module';
import { AndarBaharModule } from './andarbahar/andarbahar.module';
import { SicBoModule } from './sicbo/sicbo.module';
import { AgentModule } from './agents/agent.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),

    // Every query in this project is hand-written SQL, so there are no entities
    // and synchronize stays off — the schema is owned by the files in sql/.
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      // The explicit return type matters: without it TypeScript widens the
      // object and rejects it, because ConfigService.get() is string|undefined
      // under strictNullChecks.
      useFactory: (config: ConfigService): TypeOrmModuleOptions => ({
        type: 'mysql',
        host: config.get<string>('DB_HOST') ?? 'localhost',
        port: Number(config.get<string>('DB_PORT') ?? 3306),
        username: config.getOrThrow<string>('DB_USER'),
        password: config.getOrThrow<string>('DB_PASS'),
        database: config.getOrThrow<string>('DB_NAME'),
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

    AuthModule,
    InoutModule,
    WalletModule,
    PlatformModule,
    SportsModule,
    WheelModule,
    TeenPattiModule,
    AndarBaharModule,
    SicBoModule,
    AgentModule,
  ],
})
export class AppModule {}
