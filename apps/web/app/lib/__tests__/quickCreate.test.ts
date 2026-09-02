/**
 * The quick-create registry — who is offered which create verb.
 *
 * The whole point of a registry is that the header split button, the mobile
 * sheet and the palette cannot disagree about what this member may make. So the
 * assertions here are about the GATES, not about labels: a verb offered to
 * someone whose destination will refuse it (an editor tapping "Contact" and
 * landing on a list whose Add dialog never opens) is exactly the drift a shared
 * table is supposed to make impossible.
 */
import { describe, expect, it } from 'vitest';
import type { FeatureFlagKey } from '@owlat/shared/featureFlags';
import type { OrganizationRole } from '~/composables/useOrganization';
import type { NavigationEnvironment } from '../dashboardNavigationCore';
import {
	QUICK_CREATE_ENTRIES,
	defaultQuickCreateEntry,
	quickCreateEntriesFor,
} from '../quickCreate';
import { createTestI18n } from '~/__tests__/i18n';

function env(
	role: OrganizationRole | null,
	flags: readonly FeatureFlagKey[] | 'all' = 'all'
): NavigationEnvironment {
	return {
		isFeatureEnabled: (flag) => flags === 'all' || flags.includes(flag),
		isDesktop: false,
		role,
	};
}

const ids = (environment: NavigationEnvironment) =>
	quickCreateEntriesFor(environment).map((entry) => entry.id);

describe('quickCreateEntriesFor', () => {
	it('offers an owner every verb, in registry order', () => {
		expect(ids(env('owner'))).toEqual(['compose', 'campaign', 'contact', 'automation']);
	});

	it('keeps an editor to the verbs an editor may actually complete', () => {
		// Contacts and automations are admin work (`canManageContacts`, the
		// administration rail); campaigns are the editor's whole job.
		expect(ids(env('editor'))).toEqual(['compose', 'campaign']);
	});

	it('fails closed while the role is still unresolved', () => {
		expect(ids(env(null))).toEqual(['compose', 'campaign']);
	});

	it('drops compose on an instance with no mail at all', () => {
		expect(ids(env('owner', ['campaigns', 'automations']))).toEqual([
			'campaign',
			'contact',
			'automation',
		]);
	});

	it('keeps compose when either mail surface is enabled', () => {
		expect(ids(env('owner', ['postbox']))).toContain('compose');
		expect(ids(env('owner', ['mail.external']))).toContain('compose');
	});

	it('drops the flag-gated verbs when their features are off', () => {
		expect(ids(env('owner', ['postbox']))).toEqual(['compose', 'contact']);
	});

	it('offers nothing to an editor on an instance with neither mail nor campaigns', () => {
		expect(ids(env('editor', []))).toEqual([]);
	});
});

describe('defaultQuickCreateEntry', () => {
	it('is compose wherever there is mail — the verb the `c` chord runs', () => {
		const entry = defaultQuickCreateEntry(env('owner'));
		expect(entry?.id).toBe('compose');
		expect(entry?.shortcutId).toBe('global.compose');
	});

	it('falls through to the next allowed verb rather than a dead button', () => {
		expect(defaultQuickCreateEntry(env('owner', ['campaigns']))?.id).toBe('campaign');
		expect(defaultQuickCreateEntry(env('editor', []))).toBeNull();
	});
});

describe('the registry itself', () => {
	it('has a unique id per verb', () => {
		const seen = QUICK_CREATE_ENTRIES.map((entry) => entry.id);
		expect(seen.length).toBe(new Set(seen).size);
	});

	it('resolves every label through the real message catalog', () => {
		const { t } = createTestI18n().global;
		const missing = QUICK_CREATE_ENTRIES.filter((entry) => t(entry.labelKey) === entry.labelKey);
		expect(missing.map((entry) => entry.labelKey)).toEqual([]);
	});

	it('gives the overlay verbs no href, so nobody navigates instead of creating', () => {
		const byId = new Map(QUICK_CREATE_ENTRIES.map((entry) => [entry.id, entry]));
		expect(byId.get('compose')?.href).toBeUndefined();
		expect(byId.get('contact')?.href).toBeUndefined();
		expect(byId.get('campaign')?.href).toBe('/dashboard/campaigns/new');
		expect(byId.get('automation')?.href).toBe('/dashboard/automations/new');
	});
});
