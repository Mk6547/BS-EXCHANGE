import {
  BadRequestException, Body, Controller, Delete, Get, Param, Post, Put, Req, UseGuards,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { AdminGuard, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuditService } from './audit.service';
import { parseJson } from './content.controller';

/**
 * Configuration the admin owns: payment methods, banners, promotions and site
 * settings. All of it is data, so adding a new payment method or promotion
 * never requires a code change or a deploy.
 */
@Controller('admin')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminConfigController {
  constructor(
    private readonly ds: DataSource,
    private readonly audit: AuditService,
  ) {}

  // -------------------------------------------------------- payment methods

  @Get('payment-methods')
  async listMethods() {
    const rows = await this.ds.query(`SELECT * FROM payment_method ORDER BY sort_order, display_name`);
    return { methods: rows.map((r: any) => ({ ...r, required_fields: parseJson(r.required_fields) ?? [] })) };
  }

  @Post('payment-methods')
  async createMethod(@Req() req: any, @Body() body: any) {
    const id = randomUUID();
    const v = methodValues(body);
    if (!v.code || !v.display_name) {
      throw new BadRequestException({ message: 'A code and display name are required.' });
    }
    await this.ds.query(
      `INSERT INTO payment_method
        (id, code, display_name, kind, logo_url, currency, enabled, supports_deposit, supports_withdrawal,
         min_deposit, max_deposit, min_withdrawal, max_withdrawal, deposit_fee_pct, withdrawal_fee_pct,
         instructions, pay_to_details, required_fields, sort_order)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, v.code, v.display_name, v.kind, v.logo_url, v.currency, v.enabled, v.supports_deposit,
       v.supports_withdrawal, v.min_deposit, v.max_deposit, v.min_withdrawal, v.max_withdrawal,
       v.deposit_fee_pct, v.withdrawal_fee_pct, v.instructions, v.pay_to_details,
       JSON.stringify(v.required_fields), v.sort_order],
    );
    await this.audit.record({ adminId: req.user.id, action: 'method.create', target: v.code });
    return { id };
  }

  @Put('payment-methods/:id')
  async updateMethod(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    const v = methodValues(body);
    const res = await this.ds.query(
      `UPDATE payment_method SET display_name=?, kind=?, logo_url=?, currency=?, enabled=?,
         supports_deposit=?, supports_withdrawal=?, min_deposit=?, max_deposit=?, min_withdrawal=?,
         max_withdrawal=?, deposit_fee_pct=?, withdrawal_fee_pct=?, instructions=?, pay_to_details=?,
         required_fields=?, sort_order=?
       WHERE id = ?`,
      [v.display_name, v.kind, v.logo_url, v.currency, v.enabled, v.supports_deposit, v.supports_withdrawal,
       v.min_deposit, v.max_deposit, v.min_withdrawal, v.max_withdrawal, v.deposit_fee_pct,
       v.withdrawal_fee_pct, v.instructions, v.pay_to_details, JSON.stringify(v.required_fields),
       v.sort_order, id],
    );
    if (!res.affectedRows) throw new BadRequestException({ message: 'No such payment method.' });
    await this.audit.record({ adminId: req.user.id, action: 'method.update', target: id });
    return { id };
  }

  @Delete('payment-methods/:id')
  async disableMethod(@Req() req: any, @Param('id') id: string) {
    // Disabled rather than deleted: deposits and withdrawals reference it, and
    // history must stay readable.
    await this.ds.query(`UPDATE payment_method SET enabled = 0 WHERE id = ?`, [id]);
    await this.audit.record({ adminId: req.user.id, action: 'method.disable', target: id });
    return { id, enabled: false };
  }

  // ---------------------------------------------------------------- banners

  @Get('banners')
  async listBanners() {
    return { banners: await this.ds.query(`SELECT * FROM banner ORDER BY sort_order, created_at`) };
  }

  @Post('banners')
  async createBanner(@Req() req: any, @Body() b: any) {
    const id = randomUUID();
    await this.ds.query(
      `INSERT INTO banner (id, title, subtitle, image_url, mobile_image_url, cta_text, cta_link,
                           enabled, starts_at, ends_at, sort_order)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [id, str(b.title, 160), str(b.subtitle, 255), str(b.imageUrl, 512), str(b.mobileImageUrl, 512),
       str(b.ctaText, 64), str(b.ctaLink, 512), b.enabled === false ? 0 : 1,
       date(b.startsAt), date(b.endsAt), Number(b.sortOrder ?? 0)],
    );
    await this.audit.record({ adminId: req.user.id, action: 'banner.create', target: id });
    return { id };
  }

  @Put('banners/:id')
  async updateBanner(@Req() req: any, @Param('id') id: string, @Body() b: any) {
    await this.ds.query(
      `UPDATE banner SET title=?, subtitle=?, image_url=?, mobile_image_url=?, cta_text=?, cta_link=?,
         enabled=?, starts_at=?, ends_at=?, sort_order=? WHERE id=?`,
      [str(b.title, 160), str(b.subtitle, 255), str(b.imageUrl, 512), str(b.mobileImageUrl, 512),
       str(b.ctaText, 64), str(b.ctaLink, 512), b.enabled === false ? 0 : 1,
       date(b.startsAt), date(b.endsAt), Number(b.sortOrder ?? 0), id],
    );
    await this.audit.record({ adminId: req.user.id, action: 'banner.update', target: id });
    return { id };
  }

  @Delete('banners/:id')
  async deleteBanner(@Req() req: any, @Param('id') id: string) {
    await this.ds.query(`DELETE FROM banner WHERE id = ?`, [id]);
    await this.audit.record({ adminId: req.user.id, action: 'banner.delete', target: id });
    return { id, deleted: true };
  }

  // ------------------------------------------------------------- promotions

  @Get('promotions')
  async listPromotions() {
    return { promotions: await this.ds.query(`SELECT * FROM promotion ORDER BY sort_order, created_at`) };
  }

  @Post('promotions')
  async createPromotion(@Req() req: any, @Body() p: any) {
    const id = randomUUID();
    const slug = String(p.slug ?? '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
    if (!slug || !p.title) throw new BadRequestException({ message: 'A slug and title are required.' });
    await this.ds.query(
      `INSERT INTO promotion (id, slug, title, summary, body, image_url, bonus_pct, min_deposit,
                              max_bonus, terms, enabled, starts_at, ends_at, sort_order)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, slug, str(p.title, 160), str(p.summary, 255), p.body ?? null, str(p.imageUrl, 512),
       num(p.bonusPct), num(p.minDeposit), num(p.maxBonus), p.terms ?? null,
       p.enabled === false ? 0 : 1, date(p.startsAt), date(p.endsAt), Number(p.sortOrder ?? 0)],
    );
    await this.audit.record({ adminId: req.user.id, action: 'promotion.create', target: slug });
    return { id, slug };
  }

  @Put('promotions/:id')
  async updatePromotion(@Req() req: any, @Param('id') id: string, @Body() p: any) {
    await this.ds.query(
      `UPDATE promotion SET title=?, summary=?, body=?, image_url=?, bonus_pct=?, min_deposit=?,
         max_bonus=?, terms=?, enabled=?, starts_at=?, ends_at=?, sort_order=? WHERE id=?`,
      [str(p.title, 160), str(p.summary, 255), p.body ?? null, str(p.imageUrl, 512),
       num(p.bonusPct), num(p.minDeposit), num(p.maxBonus), p.terms ?? null,
       p.enabled === false ? 0 : 1, date(p.startsAt), date(p.endsAt), Number(p.sortOrder ?? 0), id],
    );
    await this.audit.record({ adminId: req.user.id, action: 'promotion.update', target: id });
    return { id };
  }

  @Delete('promotions/:id')
  async deletePromotion(@Req() req: any, @Param('id') id: string) {
    await this.ds.query(`DELETE FROM promotion WHERE id = ?`, [id]);
    await this.audit.record({ adminId: req.user.id, action: 'promotion.delete', target: id });
    return { id, deleted: true };
  }

  // --------------------------------------------------------------- settings

  @Get('settings')
  async settings() {
    const rows = await this.ds.query(`SELECT key_name, value FROM site_setting`);
    const out: Record<string, string> = {};
    for (const r of rows) out[r.key_name] = r.value;
    return out;
  }

  @Put('settings')
  async updateSettings(@Req() req: any, @Body() body: Record<string, string>) {
    // Whitelisted, so a compromised admin session cannot write arbitrary keys
    // that some other part of the system might later read as configuration.
    const allowed = ['site_name', 'currency_display', 'support_whatsapp', 'support_telegram',
      'support_email', 'maintenance_mode', 'logo_url',
      'whatsapp_float_number', 'whatsapp_float_enabled'];
    const changed: string[] = [];
    for (const [key, value] of Object.entries(body ?? {})) {
      if (!allowed.includes(key)) continue;
      await this.ds.query(
        `INSERT INTO site_setting (key_name, value) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE value = VALUES(value)`,
        [key, String(value ?? '').slice(0, 2000)],
      );
      changed.push(key);
    }
    await this.audit.record({ adminId: req.user.id, action: 'settings.update', metadata: { changed } });
    return { changed };
  }
}

function methodValues(b: any) {
  return {
    code: String(b.code ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, ''),
    display_name: str(b.displayName, 96),
    kind: str(b.kind, 24) ?? 'manual',
    logo_url: str(b.logoUrl, 512),
    currency: str(b.currency, 16) ?? 'PKR',
    enabled: b.enabled === false ? 0 : 1,
    supports_deposit: b.supportsDeposit === false ? 0 : 1,
    supports_withdrawal: b.supportsWithdrawal ? 1 : 0,
    min_deposit: num(b.minDeposit) ?? 0,
    max_deposit: num(b.maxDeposit),
    min_withdrawal: num(b.minWithdrawal) ?? 0,
    max_withdrawal: num(b.maxWithdrawal),
    deposit_fee_pct: num(b.depositFeePct) ?? 0,
    withdrawal_fee_pct: num(b.withdrawalFeePct) ?? 0,
    instructions: b.instructions ?? null,
    pay_to_details: b.payToDetails ?? null,
    required_fields: Array.isArray(b.requiredFields) ? b.requiredFields.slice(0, 10) : [],
    sort_order: Number(b.sortOrder ?? 0),
  };
}

const str = (v: any, max: number) => (v === undefined || v === null || v === '' ? null : String(v).slice(0, max));
const num = (v: any) => (v === undefined || v === null || v === '' ? null : Number(v));
const date = (v: any) => (v ? new Date(v) : null);
