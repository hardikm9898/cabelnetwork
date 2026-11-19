import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { listSyncReviewQuery, ListSyncReviewQuery, reviewSyncOpRequest, syncPullQuery, syncPushRequest, SyncPushRequest } from '@cablenet/contracts';
import { AnyAuthenticated, CurrentUser, RequirePermissions } from '../../common/decorators';
import type { AuthUser } from '../../common/request-context';
import { ZodBody, ZodQuery } from '../../common/zod';
import { SyncService } from './sync.service';

@ApiTags('sync')
@ApiBearerAuth()
@Controller()
export class SyncController {
  constructor(private readonly sync: SyncService) {}

  /** Agent's customers and day summary for offline use. `etag` skips an unchanged download. */
  @AnyAuthenticated()
  @Get('sync/pull')
  pull(@CurrentUser() user: AuthUser, @ZodQuery(syncPullQuery) q: z.infer<typeof syncPullQuery>) {
    return this.sync.pull(user, q.etag);
  }

  /** Operations recorded on the phone. Each op id is applied at most once; replays return the stored outcome. */
  @AnyAuthenticated()
  @Post('sync/push')
  @HttpCode(200)
  push(@CurrentUser() user: AuthUser, @ZodBody(syncPushRequest) body: SyncPushRequest) {
    return this.sync.push(user, body);
  }

  /** Office queue: offline entries that were flagged or rejected. */
  @RequirePermissions('payments:verify')
  @Get('sync/review')
  reviewList(@ZodQuery(listSyncReviewQuery) q: ListSyncReviewQuery) {
    return this.sync.reviewList(q);
  }

  @RequirePermissions('payments:verify')
  @Get('sync/review/count')
  async reviewCount() {
    return { open: await this.sync.openReviewCount() };
  }

  @RequirePermissions('payments:verify')
  @Post('sync/review/:opId')
  @HttpCode(200)
  review(@CurrentUser() user: AuthUser, @Param('opId', ParseUUIDPipe) opId: string, @ZodBody(reviewSyncOpRequest) body: z.infer<typeof reviewSyncOpRequest>) {
    return this.sync.review(opId, body.note, user);
  }
}
