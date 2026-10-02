import { BadRequestException, Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { TeenPattiService, TpError } from './teenpatti.service';

/** The Teen Patti table, as the player sees it. */
@Controller('teenpatti')
export class TeenPattiController {
  constructor(
    private readonly ds: DataSource,
    private readonly tp: TeenPattiService,
  ) {}

  @Get('state')
  state(@Req() req: any) {
    return this.tp.state(req.user?.id);
  }

  @Get('state/mine')
  @UseGuards(JwtAuthGuard)
  mine(@Req() req: any) {
    return this.tp.state(req.user.id);
  }

  @Post('bets')
  @UseGuards(JwtAuthGuard)
  async bet(@Req() req: any, @Body() body: { market: any; selection: any; side: any; stake: string }) {
    const [user] = await this.ds.query(`SELECT currency FROM users WHERE id = ?`, [req.user.id]);
    try {
      return await this.tp.placeBet({
        userId: req.user.id,
        currency: user?.currency ?? 'PKR',
        market: body?.market,
        selection: body?.selection,
        side: body?.side ?? 'back',
        stake: String(body?.stake ?? ''),
      });
    } catch (err: any) {
      if (err instanceof TpError) throw new BadRequestException({ message: err.message });
      throw new BadRequestException({ message: err?.message ?? 'The bet could not be placed.' });
    }
  }

  @Get('bets')
  @UseGuards(JwtAuthGuard)
  async myBets(@Req() req: any, @Query('limit') limit?: string) {
    return { bets: await this.tp.myRecentBets(req.user.id, Number(limit ?? 30)) };
  }
}
