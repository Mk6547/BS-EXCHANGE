import {
  BadRequestException, Body, Controller, Delete, Get, Param, Post, Put, Query, Req, UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuditService } from '../platform/audit.service';
import { AgentError, AgentService } from './agent.service';
import { WinlossSyncService } from './winloss-sync.service';
import { MasterGuard, StaffGuard } from './agent.guards';

/**
 * Master and admin management.
 *
 * Master-only routes create and fund admins. Shared routes (players, sheets)
 * are scoped inside by role: an admin sees only their own, the master sees all.
 */
@Controller('staff')
@UseGuards(JwtAuthGuard, StaffGuard)
export class AgentController {
  constructor(
    private readonly agents: AgentService,
    private readonly sync: WinlossSyncService,
    private readonly audit: AuditService,
  ) {}

  /** Who am I — the panel uses this to decide what to show. */
  @Get('me')
  async me(@Req() req: any) {
    const u = await this.agents.userRow(req.user.id);
    return {
      id: u.id, nickname: u.nickname, role: u.role,
      commissionPct: Number(u.commission_pct).toFixed(1),
      floatLimit: Number(u.float_limit).toFixed(2),
      floatUsed: Number(u.float_used).toFixed(2),
      floatLeft: (Number(u.float_limit) - Number(u.float_used)).toFixed(2),
    };
  }

  @Get('categories')
  categories() {
    return this.agents.categories().then((categories) => ({ categories }));
  }

  @Get('max-bets/:id')
  async getMaxBets(@Param('id') id: string) {
    return { maxBets: await this.agents.getMaxBets(id) };
  }

  @Put('max-bets/:id')
  async setMaxBets(@Req() req: any, @Param('id') id: string, @Body() b: any) {
    try {
      const out = await this.agents.setMaxBets({
        actorId: req.user.id, actorRole: req.user.role, targetId: id, maxBets: b?.maxBets || {},
      });
      await this.audit.record({ adminId: req.user.id, action: 'agent.maxbets.set', target: id });
      return out;
    } catch (e) { throw wrap(e); }
  }

  // ---------------------------------------------------------- admins (master)

  @Get('admins')
  @UseGuards(MasterGuard)
  admins() {
    return this.agents.listAdmins().then((admins) => ({ admins }));
  }

  @Post('admins')
  @UseGuards(MasterGuard)
  async createAdmin(@Req() req: any, @Body() b: any) {
    try {
      const out = await this.agents.createAdmin({
        nickname: b?.nickname, password: b?.password, commissionPct: b?.commissionPct, masterId: req.user.id, maxBets: b?.maxBets,
      } as any);
      await this.audit.record({ adminId: req.user.id, action: 'agent.admin.create', target: out.id, metadata: { nickname: out.nickname } });
      return out;
    } catch (e) { throw wrap(e); }
  }

  @Put('admins/:id')
  @UseGuards(MasterGuard)
  async updateAdmin(@Req() req: any, @Param('id') id: string, @Body() b: any) {
    try {
      const out = await this.agents.updateAdmin(id, { commissionPct: b?.commissionPct, status: b?.status });
      await this.audit.record({ adminId: req.user.id, action: 'agent.admin.update', target: id, metadata: b });
      return out;
    } catch (e) { throw wrap(e); }
  }

  @Put('admins/:id/password')
  @UseGuards(MasterGuard)
  async setAdminPassword(@Req() req: any, @Param('id') id: string, @Body() b: any) {
    try {
      const out = await this.agents.setAdminPassword(id, String(b?.password ?? ''));
      await this.audit.record({ adminId: req.user.id, action: 'agent.admin.password', target: id });
      return out;
    } catch (e) { throw wrap(e); }
  }

  @Delete('admins/:id')
  @UseGuards(MasterGuard)
  async deleteAdmin(@Req() req: any, @Param('id') id: string) {
    try {
      const out = await this.agents.deleteAdmin(id, req.user.id);
      await this.audit.record({ adminId: req.user.id, action: 'agent.admin.delete', target: id, metadata: out });
      return out;
    } catch (e) { throw wrap(e); }
  }

  @Post('admins/:id/fund')
  @UseGuards(MasterGuard)
  async fund(@Req() req: any, @Param('id') id: string, @Body() b: any) {
    try {
      const out = await this.agents.fundAdmin({
        masterId: req.user.id, adminId: id, kind: b?.kind, amount: String(b?.amount ?? ''), note: b?.note,
      });
      await this.audit.record({ adminId: req.user.id, action: 'agent.admin.fund', target: id, metadata: { kind: b?.kind, amount: b?.amount } });
      return out;
    } catch (e) { throw wrap(e); }
  }

  /** Master's oversight of one admin: float record + win/loss sheet. */
  @Get('admins/:id/sheet')
  @UseGuards(MasterGuard)
  async adminSheet(@Param('id') id: string, @Query() q: any) {
    await this.sync.tick();
    const [floatSheet, winloss, players] = await Promise.all([
      this.agents.floatSheet(id),
      this.agents.winlossSheet(id, q.from, q.to),
      this.agents.listPlayers(id),
    ]);
    return { floatSheet, winloss, players };
  }

  // ------------------------------------------------------------ mini admins

  @Get('minis')
  async minis(@Req() req: any, @Query() q: any) {
    if (req.user.role === 'master') return { minis: await this.agents.allMinis() };
    if (req.user.role === 'admin') return { minis: await this.agents.listMinis(req.user.id) };
    return { minis: [] }; // a mini admin has none
  }

  @Post('minis')
  async createMini(@Req() req: any, @Body() b: any) {
    if (req.user.role !== 'admin') throw new BadRequestException({ message: 'Only an admin can create a mini admin.' });
    try {
      const out = await this.agents.createMini({ adminId: req.user.id, nickname: b?.nickname, password: b?.password, sharePct: b?.sharePct });
      await this.audit.record({ adminId: req.user.id, action: 'agent.mini.create', target: out.id, metadata: { nickname: out.nickname, sharePct: b?.sharePct } });
      return out;
    } catch (e) { throw wrap(e); }
  }

  @Put('minis/:id')
  async updateMini(@Req() req: any, @Param('id') id: string, @Body() b: any) {
    if (req.user.role !== 'admin') throw new BadRequestException({ message: 'Only the owning admin can edit a mini admin.' });
    try {
      const out = await this.agents.updateMini({ adminId: req.user.id, miniId: id, sharePct: b?.sharePct, status: b?.status, password: b?.password });
      await this.audit.record({ adminId: req.user.id, action: 'agent.mini.update', target: id, metadata: b });
      return out;
    } catch (e) { throw wrap(e); }
  }

  @Delete('minis/:id')
  async deleteMini(@Req() req: any, @Param('id') id: string) {
    if (req.user.role !== 'admin') throw new BadRequestException({ message: 'Only the owning admin can delete a mini admin.' });
    try {
      const out = await this.agents.deleteMini({ adminId: req.user.id, miniId: id });
      await this.audit.record({ adminId: req.user.id, action: 'agent.mini.delete', target: id, metadata: out });
      return out;
    } catch (e) { throw wrap(e); }
  }

  @Post('minis/:id/fund')
  async fundMini(@Req() req: any, @Param('id') id: string, @Body() b: any) {
    if (req.user.role !== 'admin') throw new BadRequestException({ message: 'Only the owning admin can fund a mini admin.' });
    try {
      const out = await this.agents.fundMini({ adminId: req.user.id, miniId: id, kind: b?.kind, amount: String(b?.amount ?? ''), note: b?.note });
      await this.audit.record({ adminId: req.user.id, action: 'agent.mini.fund', target: id, metadata: { kind: b?.kind, amount: b?.amount } });
      return out;
    } catch (e) { throw wrap(e); }
  }

  // ---------------------------------------------------------- players (both)

  @Get('players')
  async players(@Req() req: any, @Query() q: any) {
    // Master may pass all=1 to see everyone; an admin is always scoped to own.
    const all = req.user.role === 'master' && q.all === '1';
    const ownerId = req.user.role === 'master' && q.owner ? q.owner : req.user.id;
    const players = await this.agents.listPlayers(ownerId, { search: q.search, all });
    return { players };
  }

  @Post('players')
  async createPlayer(@Req() req: any, @Body() b: any) {
    try {
      const out = await this.agents.createPlayer({ ownerId: req.user.id, nickname: b?.nickname, password: b?.password, maxBets: b?.maxBets } as any);
      await this.audit.record({ adminId: req.user.id, action: 'agent.player.create', target: out.id, metadata: { nickname: out.nickname } });
      return out;
    } catch (e) { throw wrap(e); }
  }

  @Post('players/:id/adjust')
  async adjustPlayer(@Req() req: any, @Param('id') id: string, @Body() b: any) {
    try {
      const out = await this.agents.adjustPlayer({
        actorId: req.user.id, actorRole: req.user.role, playerId: id, delta: String(b?.delta ?? ''), note: b?.note,
      });
      await this.audit.record({ adminId: req.user.id, action: 'agent.player.adjust', target: id, metadata: { delta: b?.delta } });
      return out;
    } catch (e) { throw wrap(e); }
  }

  @Get('players/:id/detail')
  async playerDetail(@Req() req: any, @Param('id') id: string) {
    try {
      return await this.agents.playerDetail({ actorId: req.user.id, actorRole: req.user.role, playerId: id });
    } catch (e) { throw wrap(e); }
  }

  @Put('players/:id/password')
  async setPlayerPassword(@Req() req: any, @Param('id') id: string, @Body() b: any) {
    try {
      const out = await this.agents.setPlayerPassword({ actorId: req.user.id, actorRole: req.user.role, playerId: id, password: String(b?.password ?? '') });
      await this.audit.record({ adminId: req.user.id, action: 'agent.player.password', target: id });
      return out;
    } catch (e) { throw wrap(e); }
  }

  @Put('players/:id/status')
  async setPlayerStatus(@Req() req: any, @Param('id') id: string, @Body() b: any) {
    try {
      const out = await this.agents.setPlayerStatus({ actorId: req.user.id, actorRole: req.user.role, playerId: id, status: b?.status });
      await this.audit.record({ adminId: req.user.id, action: 'agent.player.status', target: id, metadata: { status: b?.status } });
      return out;
    } catch (e) { throw wrap(e); }
  }

  @Delete('players/:id')
  async deletePlayer(@Req() req: any, @Param('id') id: string) {
    try {
      const out = await this.agents.deletePlayer({ actorId: req.user.id, actorRole: req.user.role, playerId: id });
      await this.audit.record({ adminId: req.user.id, action: 'agent.player.delete', target: id });
      return out;
    } catch (e) { throw wrap(e); }
  }

  // ------------------------------------------------------ sports (per-owner)

  @Get('sports')
  async sports(@Req() req: any) {
    // master uses the full Sports events screen; this is for admin/mini.
    if (req.user.role === 'master') return { events: [] };
    return { events: await this.agents.ownerSportsList(req.user.id) };
  }

  @Post('sports/:eventId/suspend')
  async suspendSport(@Req() req: any, @Param('eventId') eventId: string, @Body() b: any) {
    if (req.user.role === 'master') throw new BadRequestException({ message: 'Use the main Sports events screen.' });
    const out = await this.agents.setOwnerSuspend({ ownerId: req.user.id, eventId, suspend: !!b?.suspend });
    await this.audit.record({ adminId: req.user.id, action: 'agent.sport.suspend', target: eventId, metadata: { suspend: !!b?.suspend } });
    return out;
  }

  // --------------------------------------------------------- account ledger

  @Get('ledger/accounts')
  async ledgerAccounts(@Req() req: any, @Query() q: any) {
    return this.agents.ledgerAccounts({ viewerId: req.user.id, viewerRole: req.user.role, viewAs: q.viewAs });
  }

  @Get('ledger')
  async ledger(@Req() req: any, @Query() q: any) {
    return this.agents.accountLedger({
      viewerId: req.user.id, viewerRole: req.user.role, viewAs: q.viewAs,
      account: q.account || '_transactions', from: q.from, to: q.to,
    });
  }

  // ------------------------------------------------------------- own sheets

  /** An admin's own win/loss sheet; the master gets the same via /admins/:id/sheet. */
  @Get('winloss')
  async winloss(@Req() req: any, @Query() q: any) {
    await this.sync.tick();
    // master may view any admin/mini; staff view their own, scoped by role.
    const staffId = req.user.role === 'master' && q.admin ? q.admin : req.user.id;
    const role = req.user.role === 'master' ? (q.role || 'admin') : req.user.role;
    return this.agents.winlossSheet(staffId, q.from, q.to, role);
  }

  @Get('float')
  async float(@Req() req: any, @Query() q: any) {
    const adminId = req.user.role === 'master' && q.admin ? q.admin : req.user.id;
    if (req.user.role === 'master' && !q.admin) return { floatLimit: '—', floatUsed: '—', floatLeft: '—', commissionPct: '—', funding: [] };
    return this.agents.floatSheet(adminId);
  }
}

function wrap(e: any) {
  if (e instanceof AgentError) return new BadRequestException({ message: e.message });
  return new BadRequestException({ message: e?.message ?? 'Something went wrong.' });
}
