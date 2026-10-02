import { BadRequestException, Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SicBoService, SbError } from './sicbo.service';

@Controller('sicbo')
export class SicBoController {
  constructor(private readonly ds: DataSource, private readonly sb: SicBoService) {}

  @Get('state')
  state(@Req() req: any) { return this.sb.state(req.user?.id); }

  @Get('state/mine')
  @UseGuards(JwtAuthGuard)
  mine(@Req() req: any) { return this.sb.state(req.user.id); }

  @Post('bets')
  @UseGuards(JwtAuthGuard)
  async bet(@Req() req: any, @Body() b: { market: string; selection: string; stake: string }) {
    const [u] = await this.ds.query(`SELECT currency FROM users WHERE id=?`, [req.user.id]);
    try {
      return await this.sb.placeBet({ userId: req.user.id, currency: u?.currency ?? 'PKR', market: b?.market, selection: b?.selection, stake: String(b?.stake ?? '') });
    } catch (e: any) {
      if (e instanceof SbError) throw new BadRequestException({ message: e.message });
      throw new BadRequestException({ message: e?.message ?? 'The bet could not be placed.' });
    }
  }

  @Get('bets')
  @UseGuards(JwtAuthGuard)
  async myBets(@Req() req: any, @Query('limit') limit?: string) {
    return { bets: await this.sb.myRecentBets(req.user.id, Number(limit ?? 30)) };
  }
}
