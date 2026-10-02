import { BadRequestException, Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { WheelError, WheelService } from './wheel.service';

/** What the wheel screen reads and writes. */
@Controller('wheel')
export class WheelController {
  constructor(
    private readonly ds: DataSource,
    private readonly wheel: WheelService,
  ) {}

  /** Polled by the game screen: items, live round, countdown, my stakes, history. */
  @Get('state')
  async state(@Req() req: any) {
    const userId = req.user?.id;
    return this.wheel.state(userId);
  }

  @Get('state/mine')
  @UseGuards(JwtAuthGuard)
  async mine(@Req() req: any) {
    return this.wheel.state(req.user.id);
  }

  @Post('bets')
  @UseGuards(JwtAuthGuard)
  async bet(@Req() req: any, @Body() body: { itemId: string; stake: string }) {
    const [user] = await this.ds.query(`SELECT currency FROM users WHERE id = ?`, [req.user.id]);
    try {
      return await this.wheel.placeBet({
        userId: req.user.id,
        currency: user?.currency ?? 'PKR',
        itemId: body?.itemId,
        stake: String(body?.stake ?? ''),
      });
    } catch (err: any) {
      if (err instanceof WheelError) throw new BadRequestException({ message: err.message });
      throw new BadRequestException({ message: err?.message ?? 'The bet could not be placed.' });
    }
  }

  @Get('bets')
  @UseGuards(JwtAuthGuard)
  async myBets(@Req() req: any, @Query('limit') limit?: string) {
    return { bets: await this.wheel.myRecentBets(req.user.id, Number(limit ?? 30)) };
  }
}
