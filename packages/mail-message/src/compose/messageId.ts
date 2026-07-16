/**
 * RFC 5322 §3.6.4 Message-ID generation. Domain-scoped and globally unique
 * (time component + crypto-random suffix). The only impurities are `Date.now()`
 * and `node:crypto` random bytes.
 */

import { randomBytes } from 'node:crypto';

export function buildMessageId(domain: string): string {
	return `<${Date.now().toString(36)}.${randomBytes(6).toString('hex')}@${domain}>`;
}
