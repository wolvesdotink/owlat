/**
 * Tests for the email-client registry that lives in @owlat/shared.
 *
 * Per-block Feature compatibility and Property compatibility live in Block
 * modules (see `packages/email-renderer/src/blocks/<type>/index.ts`) and are
 * read through the Compatibility walker — those parity tests live next to the
 * walker in `packages/email-renderer`. The tests here only cover what shared
 * still owns: the email-client baseline seeding and `lookupClientSupport`.
 */

import { describe, it, expect } from 'vitest';
import { emailClientRegistry, lookupClientSupport } from '../registry';
import { emailClients } from '../clients';
import type { SupportLevel } from '../types';

describe('compatibility registry — lifecycle', () => {
	it('seeds emailClientRegistry from the static emailClients map at module load', () => {
		const keys = emailClientRegistry.keys().sort();
		expect(keys).toEqual(Object.keys(emailClients).sort());
		for (const [key, info] of Object.entries(emailClients)) {
			expect(emailClientRegistry.get(key)).toBe(info);
		}
	});
});

describe('compatibility registry — contract', () => {
	it('every emailClientRegistry entry has name/renderEngine/marketSharePercent', () => {
		for (const [key, info] of emailClientRegistry.entries()) {
			expect(typeof key).toBe('string');
			expect(typeof info.name).toBe('string');
			expect(typeof info.renderEngine).toBe('string');
			expect(typeof info.marketSharePercent).toBe('number');
		}
	});
});

describe('compatibility registry — failure modes', () => {
	it('returns undefined for an unknown client key', () => {
		expect(emailClientRegistry.get('not-a-real-client')).toBeUndefined();
	});

	it('lookupClientSupport tolerates keys outside the strict ClientSupport union', () => {
		const support = { gmail: 'full', custom: 'partial' } as unknown as Record<string, SupportLevel>;
		expect(lookupClientSupport(support, 'gmail')).toBe('full');
		expect(lookupClientSupport(support, 'custom')).toBe('partial');
		expect(lookupClientSupport(support, 'nope')).toBeUndefined();
	});
});
