/**
 * Tests for the compatibility extension registries that live in @owlat/shared.
 *
 * Per-block Feature compatibility and Property compatibility now live in Block
 * modules (see `packages/email-renderer/src/blocks/<type>/index.ts`) and are
 * read through the Compatibility walker — those parity tests live next to the
 * walker in `packages/email-renderer`. The tests here only cover what shared
 * still owns: the extension registries, the email-client baseline seeding, and
 * the `mergeBlockCompatibility` / `lookupClientSupport` helpers.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
	emailClientRegistry,
	blockCompatibilityRegistry,
	registerEmailClient,
	unregisterEmailClient,
	registerBlockCompatibility,
	unregisterBlockCompatibility,
	getAllEmailClients,
	getEmailClientInfo,
	mergeBlockCompatibility,
	lookupClientSupport,
} from '../registry';
import { emailClients } from '../clients';
import type {
	ClientSupport,
	FeatureCompatibility,
	EmailClientInfo,
	SupportLevel,
} from '../types';

describe('compatibility registry — lifecycle', () => {
	it('seeds emailClientRegistry from the static emailClients map at module load', () => {
		const keys = emailClientRegistry.keys().sort();
		expect(keys).toEqual(Object.keys(emailClients).sort());
	});

	it('blockCompatibilityRegistry is empty at module load (extension-only)', () => {
		expect(blockCompatibilityRegistry.keys()).toEqual([]);
	});

	it('register/get/unregister on emailClientRegistry behave correctly', () => {
		const info: EmailClientInfo = {
			name: 'Test client',
			renderEngine: 'webkit',
			marketSharePercent: 1.0,
		};
		registerEmailClient('test-client-x', info);
		try {
			expect(getEmailClientInfo('test-client-x')).toBe(info);
			expect(getAllEmailClients()['test-client-x']).toBe(info);
		} finally {
			expect(unregisterEmailClient('test-client-x')).toBe(true);
			expect(unregisterEmailClient('test-client-x')).toBe(false);
		}
	});

	it('register/unregister on blockCompatibilityRegistry behave correctly', () => {
		const entries: FeatureCompatibility[] = [
			{
				feature: 'extra-feature',
				description: 'plugin-added feature',
				support: { gmail: 'full' } as unknown as ClientSupport,
				fallback: 'graceful-fallback',
				owlatHandled: false,
			},
		];
		registerBlockCompatibility('text', entries);
		try {
			expect(blockCompatibilityRegistry.get('text')).toBe(entries);
		} finally {
			unregisterBlockCompatibility('text');
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

	it('every blockCompatibilityRegistry entry is an array of FeatureCompatibility', () => {
		for (const [block, entries] of blockCompatibilityRegistry.entries()) {
			expect(typeof block).toBe('string');
			expect(Array.isArray(entries)).toBe(true);
			for (const e of entries) {
				expect(typeof e.feature).toBe('string');
				expect(typeof e.description).toBe('string');
				expect(typeof e.support).toBe('object');
			}
		}
	});
});

describe('compatibility registry — merge helper', () => {
	afterEach(() => {
		unregisterBlockCompatibility('text');
	});

	it('mergeBlockCompatibility returns the baseline when no plugin entries exist', () => {
		const baseline: FeatureCompatibility[] = [];
		expect(mergeBlockCompatibility('text', baseline)).toBe(baseline);
	});

	it('appends plugin-registered entries onto the baseline', () => {
		const baseline: FeatureCompatibility[] = [
			{
				feature: 'baseline-feature',
				description: 'from the module',
				support: { gmail: 'full' } as unknown as ClientSupport,
				fallback: '',
				owlatHandled: false,
			},
		];
		registerBlockCompatibility('text', [
			{
				feature: 'plugin-only-rule',
				description: 'added by a plugin',
				support: { gmail: 'full' } as unknown as ClientSupport,
				fallback: 'graceful-fallback',
				owlatHandled: false,
			},
		]);
		const merged = mergeBlockCompatibility('text', baseline);
		expect(merged.length).toBe(2);
		expect(merged.map((f) => f.feature)).toEqual(['baseline-feature', 'plugin-only-rule']);
	});
});

describe('compatibility registry — failure modes', () => {
	it('getEmailClientInfo returns undefined for unknown keys', () => {
		expect(getEmailClientInfo('not-a-real-client')).toBeUndefined();
	});

	it('lookupClientSupport tolerates keys outside the strict ClientSupport union', () => {
		const support = { gmail: 'full', custom: 'partial' } as unknown as Record<
			string,
			SupportLevel
		>;
		expect(lookupClientSupport(support, 'gmail')).toBe('full');
		expect(lookupClientSupport(support, 'custom')).toBe('partial');
		expect(lookupClientSupport(support, 'nope')).toBeUndefined();
	});
});
