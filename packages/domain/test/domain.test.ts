import { describe, expect, it } from 'vitest';
import {
  addDays,
  businessDateOf,
  businessDaySpanToInstants,
  canReadAllCustomers,
  cleanText,
  hasPermission,
  isBusinessDate,
  matchKey,
  normalizeIndianMobile,
  startOfBusinessDay,
} from '../src';

describe('permissions', () => {
  it('agents can only read assigned customers', () => {
    expect(hasPermission('AGENT', 'customers:read:assigned')).toBe(true);
    expect(hasPermission('AGENT', 'customers:read:all')).toBe(false);
    expect(hasPermission('AGENT', 'customers:manage')).toBe(false);
    expect(hasPermission('AGENT', 'assignments:manage')).toBe(false);
    expect(canReadAllCustomers('AGENT')).toBe(false);
  });

  it('admins cannot manage users, settings or imports; super admins can', () => {
    expect(hasPermission('ADMIN', 'users:manage')).toBe(false);
    expect(hasPermission('ADMIN', 'settings:manage')).toBe(false);
    expect(hasPermission('ADMIN', 'import:manage')).toBe(false);
    expect(hasPermission('SUPER_ADMIN', 'users:manage')).toBe(true);
    expect(hasPermission('SUPER_ADMIN', 'import:manage')).toBe(true);
  });
});

describe('normalizeIndianMobile', () => {
  it.each([
    ['9998659339', '9998659339', true],
    [9998659339, '9998659339', true],
    ['+91 99986 59339', '9998659339', true],
    ['09998659339', '9998659339', true],
    [999837003, '999837003', false], // real 9-digit value from the workbook: kept, flagged
    ['1234567890', '1234567890', false],
  ])('%s -> %s (valid=%s)', (raw, normalized, valid) => {
    expect(normalizeIndianMobile(raw)).toEqual({ normalized, valid });
  });

  it('returns null for empty input', () => {
    expect(normalizeIndianMobile('')).toBeNull();
    expect(normalizeIndianMobile(null)).toBeNull();
    expect(normalizeIndianMobile(' - ')).toBeNull();
  });
});

describe('business dates (Asia/Kolkata)', () => {
  it('validates calendar dates', () => {
    expect(isBusinessDate('2026-02-28')).toBe(true);
    expect(isBusinessDate('2026-02-29')).toBe(false);
    expect(isBusinessDate('2026-13-01')).toBe(false);
    expect(isBusinessDate('26-01-01')).toBe(false);
  });

  it('start of an IST day is 18:30 UTC of the previous day', () => {
    expect(startOfBusinessDay('2026-11-18').toISOString()).toBe('2026-11-17T18:30:00.000Z');
  });

  it('maps instants to IST dates across midnight', () => {
    expect(businessDateOf(new Date('2026-11-17T18:29:59Z'))).toBe('2026-11-17');
    expect(businessDateOf(new Date('2026-11-17T18:30:00Z'))).toBe('2026-11-18');
  });

  it('adds days across month and year ends', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('converts inclusive date spans to half-open instant ranges', () => {
    const { start, end } = businessDaySpanToInstants('2026-11-20', '2026-11-22');
    expect(start.toISOString()).toBe('2026-11-19T18:30:00.000Z');
    expect(end.toISOString()).toBe('2026-11-22T18:30:00.000Z');
    expect(() => businessDaySpanToInstants('2026-11-22', '2026-11-20')).toThrow(RangeError);
  });
});

describe('text', () => {
  it('cleans whitespace without re-casing', () => {
    expect(cleanText('  11 AMBIKA  NAGAR SOC ')).toBe('11 AMBIKA NAGAR SOC');
    expect(matchKey(' Laxmi  Nagar ')).toBe('laxmi nagar');
  });
});
