import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { InoutController } from './inout.controller';
// TEMPORARY — remove this import and the controller entry below before go-live.
import { InoutDebugController } from './inout-debug.controller';
import { InoutWebhookService } from './inout-webhook.service';
import { InoutSessionService } from './inout-session.service';
import { InoutLaunchService } from './inout-launch.service';
import { InoutBonusService } from './inout-bonus.service';

@Module({
  imports: [ConfigModule],
  controllers: [InoutController, InoutDebugController],
  providers: [InoutWebhookService, InoutSessionService, InoutLaunchService, InoutBonusService],
  exports: [InoutLaunchService, InoutBonusService],
})
export class InoutModule {}