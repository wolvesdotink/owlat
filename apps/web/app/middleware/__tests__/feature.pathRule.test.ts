/**
 * Unit tests for the path-derived feature gate in `feature.global.ts`.
 *
 * `pathRule` is the single source of truth that keeps route-level feature
 * gating from drifting away from the sidebar's link-hiding. We test the
 * mapping directly (longest-prefix match, built-ins ungated) rather than the
 * Nuxt middleware wrapper.
 *
 * The middleware module calls `defineNuxtRouteMiddleware` at import time, so we
 * stub that Nuxt auto-import to an identity before importing the file.
 */

import { describe, it, expect, vi } from 'vitest';

vi.stubGlobal('defineNuxtRouteMiddleware', (fn: unknown) => fn);
vi.stubGlobal('navigateTo', vi.fn());

const { pathRule, PATH_FEATURE_RULES } = await import('../feature.global');

describe('pathRule — path-derived feature gate', () => {
	it('gates the previously-ungated sections', () => {
		expect(pathRule('/dashboard/campaigns')?.required).toBe('campaigns');
		expect(pathRule('/dashboard/campaigns/new')?.required).toBe('campaigns');
		expect(pathRule('/dashboard/automations/123/edit')?.required).toBe('automations');
		expect(pathRule('/dashboard/visualizations')?.required).toBe('ai.visualizations');
		expect(pathRule('/dashboard/mail/marketing')?.required).toBe('campaigns');
		expect(pathRule('/dashboard/mail/transactional/x')?.required).toBe('transactional');
		expect(pathRule('/dashboard/knowledge/abc')?.required).toBe('ai.knowledge');
	});

	it('gates the transactional editor tree (lives outside /dashboard/mail)', () => {
		// The editor at /dashboard/transactional/[id]/{edit,sends,translations}
		// must be gated by `transactional`, not just the list at /dashboard/mail/transactional.
		expect(pathRule('/dashboard/transactional/x/edit')?.required).toBe('transactional');
		expect(pathRule('/dashboard/transactional/x/sends/y')?.required).toBe('transactional');
		expect(pathRule('/dashboard/transactional/x/translations')?.required).toBe('transactional');
		// The original list mapping under /dashboard/mail still holds.
		expect(pathRule('/dashboard/mail/transactional')?.required).toBe('transactional');
		expect(pathRule('/dashboard/mail/transactional/x')?.required).toBe('transactional');
	});

	it('keeps the already-gated sections', () => {
		expect(pathRule('/dashboard/inbox/quarantine')?.required).toBe('inbox');
		expect(pathRule('/dashboard/chat')?.required).toBe('chat');
		expect(pathRule('/dashboard/postbox/inbox')?.anyOf).toEqual(['postbox', 'mail.external']);
	});

	it('leaves always-on built-ins ungated', () => {
		// Email editor surfaces, media, files, audience/contacts, settings, root.
		expect(pathRule('/dashboard')).toBeUndefined();
		expect(pathRule('/dashboard/mail')).toBeUndefined();
		expect(pathRule('/dashboard/mail/blocks')).toBeUndefined();
		expect(pathRule('/dashboard/mail/media')).toBeUndefined();
		expect(pathRule('/dashboard/files/abc')).toBeUndefined();
		expect(pathRule('/dashboard/audience/contacts')).toBeUndefined();
		expect(pathRule('/dashboard/settings/api')).toBeUndefined();
	});

	it('does not match a prefix that is only a partial path segment', () => {
		// '/dashboard/mail/marketing' must not be matched by a hypothetical
		// '/dashboard/mail' rule, and a path that merely starts with the string
		// but is a different segment must not match.
		expect(pathRule('/dashboard/campaignsX')).toBeUndefined();
		expect(pathRule('/dashboard/inboxes')).toBeUndefined();
	});

	it('picks the longest matching prefix (mail/marketing over any mail rule)', () => {
		// mail/marketing is gated by campaigns even though /dashboard/mail itself
		// is an ungated built-in — the specific prefix wins.
		const rule = pathRule('/dashboard/mail/marketing/anything');
		expect(rule?.prefix).toBe('/dashboard/mail/marketing');
		expect(rule?.required).toBe('campaigns');
	});

	it('every rule maps to a real path under /dashboard', () => {
		for (const rule of PATH_FEATURE_RULES) {
			expect(rule.prefix.startsWith('/dashboard/')).toBe(true);
		}
	});
});
