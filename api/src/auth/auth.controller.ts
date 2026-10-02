import { Body, Controller, Get, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { BadRequestException } from '@nestjs/common';
import { AuthError, AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register')
  @HttpCode(200)
  async register(
    @Req() req: any,
    @Body() body: { identifier: string; password: string; nickname?: string; currency?: string },
  ) {
    return this.wrap(() =>
      this.auth.register({
        identifier: body?.identifier,
        password: body?.password,
        nickname: body?.nickname,
        currency: body?.currency,
        countryCode: req.headers?.['cf-ipcountry'] ?? null,
        ip: clientIp(req),
      }),
    );
  }

  @Post('login')
  @HttpCode(200)
  async login(@Req() req: any, @Body() body: { identifier: string; password: string }) {
    return this.wrap(() =>
      this.auth.login({
        identifier: body?.identifier,
        password: body?.password,
        ip: clientIp(req),
      }),
    );
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@Req() req: any) {
    return this.auth.profile(req.user.id);
  }

  /**
   * AuthError carries a message written for the player; anything else is a bug
   * and must not have its details returned.
   */
  private async wrap<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof AuthError) {
        throw new BadRequestException({ code: err.code, message: err.message });
      }
      throw err;
    }
  }
}

function clientIp(req: any): string {
  return (req.ip ?? req.socket?.remoteAddress ?? '').replace(/^::ffff:/, '');
}
