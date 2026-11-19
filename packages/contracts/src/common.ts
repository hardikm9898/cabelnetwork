import { isBusinessDate } from '@cablenet/domain';
import { z } from 'zod';

export const uuid = z.uuid();

/** Calendar date in the business time zone, `YYYY-MM-DD`. */
export const businessDate = z.string().refine(isBusinessDate, { message: 'Expected a valid date (YYYY-MM-DD)' });

export const trimmed = (max: number) => z.string().trim().min(1).max(max);
export const optionalTrimmed = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullish();

/** Free-form phone input; normalised and validated by the API (see normalizeIndianMobile). */
export const phoneInput = z.string().trim().max(20);

export const reason = z.string().trim().min(3, 'A reason is required').max(500);

export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type PaginationQuery = z.infer<typeof paginationQuery>;

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  /** Sum of the listed amounts across all pages (payment lists). */
  totalAmount?: string;
  /** Unread count (notification lists). */
  unread?: number;
}

export interface ApiError {
  error: { code: string; message: string; details?: unknown; requestId?: string };
}
