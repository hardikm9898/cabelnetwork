import { Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  ChangePasswordRequest,
  changePasswordRequest,
  LoginRequest,
  loginRequest,
  RefreshRequest,
  refreshRequest,
} from '@cablenet/contracts';
import { AllowPendingPasswordChange, AnyAuthenticated, CurrentUser, Public } from '../../common/decorators';
import type { AuthUser } from '../../common/request-context';
import { ZodBody } from '../../common/zod';
import { AuthService } from './auth.service';
import { loginThrottle } from './throttle';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Throttle({ default: loginThrottle() })
  @Post('login')
  @HttpCode(200)
  login(@ZodBody(loginRequest) body: LoginRequest) {
    return this.auth.login(body);
  }

  @Public()
  @Throttle({ default: loginThrottle() })
  @Post('refresh')
  @HttpCode(200)
  refresh(@ZodBody(refreshRequest) body: RefreshRequest) {
    return this.auth.refresh(body.refreshToken);
  }

  @ApiBearerAuth()
  @AnyAuthenticated()
  @AllowPendingPasswordChange()
  @Post('logout')
  @HttpCode(204)
  async logout(@CurrentUser() user: AuthUser): Promise<void> {
    await this.auth.logout(user);
  }

  @ApiBearerAuth()
  @AnyAuthenticated()
  @AllowPendingPasswordChange()
  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.auth.publicUser(user.id);
  }

  @ApiBearerAuth()
  @AnyAuthenticated()
  @AllowPendingPasswordChange()
  @Throttle({ default: loginThrottle() })
  @Post('change-password')
  @HttpCode(204)
  async changePassword(@CurrentUser() user: AuthUser, @ZodBody(changePasswordRequest) body: ChangePasswordRequest) {
    await this.auth.changePassword(user, body);
  }

  @ApiBearerAuth()
  @AnyAuthenticated()
  @Get('sessions')
  sessions(@CurrentUser() user: AuthUser) {
    return this.auth.listSessions(user.id, user.sessionId);
  }

  @ApiBearerAuth()
  @AnyAuthenticated()
  @Delete('sessions/:familyId')
  @HttpCode(204)
  async revokeSession(@CurrentUser() user: AuthUser, @Param('familyId', ParseUUIDPipe) familyId: string) {
    await this.auth.revokeSession(user.id, familyId, 'revoked_by_user');
  }
}
