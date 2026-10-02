import { BadRequestException, Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AndarBaharService, AbError } from './andarbahar.service';

/** Andar Bahar table, player-facing. */
@Controller('andarbahar')
export class AndarBaharController {
  constructor(private readonly ds: DataSource, private readonly ab: AndarBaharService) {}

  @Get('state')
  state(@Req() req: any) { return this.ab.state(req.user?.id); }

  @Get('state/mine')
  @UseGuards(JwtAuthGuard)
  mine(@Req() req: any) { return this.ab.state(req.user.id); }

  @Post('bets')
  @UseGuards(JwtAuthGuard)
  async bet(@Req() req: any, @Body() b: { market: string; selection: string; stake: string }) {
    const [u] = await this.ds.query(`SELECT currency FROM users WHERE id = ?`, [req.user.id]);
    try {
      return await this.ab.placeBet({
        userId: req.user.id, currency: u?.currency ?? 'PKR',
        market: b?.market, selection: b?.selection, stake: String(b?.stake ?? ''),
      });
    } catch (e: any) {
      if (e instanceof AbError) throw new BadRequestException({ message: e.message });
      throw new BadRequestException({ message: e?.message ?? 'The bet could not be placed.' });
    }
  }

  @Get('bets')
  @UseGuards(JwtAuthGuard)
  async myBets(@Req() req: any, @Query('limit') limit?: string) {
    return { bets: await this.ab.myRecentBets(req.user.id, Number(limit ?? 30)) };
  }
}
