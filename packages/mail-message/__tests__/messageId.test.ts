/**
 * RFC 5322 §3.6.4 Message-ID generation, covering the same `buildMessageId`
 * `outbound.ts` calls at dispatch time (moved into `@owlat/mail-message`).
 */

import { describe, it, expect } from 'vitest';
import { buildMessageId } from '../src/index';

describe('buildMessageId (RFC 5322 §3.6.4)', () => {
	it('is domain-scoped with a time component and a crypto-random suffix', () => {
		expect(buildMessageId('acme.test')).toMatch(/^<[0-9a-z]+\.[0-9a-f]{12}@acme\.test>$/);
	});

	it('generates globally-unique Message-IDs across 10000 drafts', () => {
		const ids = new Set<string>();
		for (let i = 0; i < 10_000; i++) {
			ids.add(buildMessageId('acme.test'));
		}
		expect(ids.size).toBe(10_000);
	});
});
