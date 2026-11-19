import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signed, expiring links to a receipt PDF so an agent can send the customer a link on
 * WhatsApp. The token is HMAC-SHA256 over "receiptId.expiry" with a key derived from the
 * server secret; it grants read access to that one receipt only, until it expires.
 */
const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export class ReceiptLinkSigner {
  private readonly key: Buffer;

  constructor(serverSecret: string) {
    this.key = createHmac('sha256', serverSecret).update('cablenet:receipt-links:v1').digest();
  }

  sign(receiptId: string, ttlDays: number, now = Date.now()): { token: string; expiresAt: Date } {
    const exp = Math.floor(now / 1000) + ttlDays * 86_400;
    const payload = `${receiptId}.${exp}`;
    const sig = createHmac('sha256', this.key).update(payload).digest();
    return { token: `${b64(payload)}.${b64(sig)}`, expiresAt: new Date(exp * 1000) };
  }

  /** Returns the receipt id when the token is authentic and unexpired, else null. */
  verify(token: string, now = Date.now()): string | null {
    const [p, s] = token.split('.');
    if (!p || !s) return null;
    let payload: string;
    try {
      payload = Buffer.from(p, 'base64url').toString('utf8');
    } catch {
      return null;
    }
    const expected = createHmac('sha256', this.key).update(payload).digest();
    const given = Buffer.from(s, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const [id, exp] = payload.split('.');
    if (!id || !exp || !/^\d+$/.test(exp) || Number(exp) * 1000 < now) return null;
    return /^[0-9a-f-]{36}$/i.test(id) ? id : null;
  }
}
