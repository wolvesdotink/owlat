/**
 * The Settings sidebar's search box. It answers to the same words ⌘K does: a
 * page's synonyms and description, and the individual controls on each page.
 */
import { describe, expect, it } from 'vitest';
import { adminAreasFor } from '../adminSettingsNav';
import type { AdminEnvironment } from '../adminSettingsRegistry';
import { settingsSectionsFor, type SettingsEnvironment } from '../settingsRegistry';
import {
	SETTINGS_SEARCH_CAP,
	settingsSearchResults,
	type SettingsSearchInput,
} from '../settingsSearch';
import { createTestI18n } from '~/__tests__/i18n';

const { t } = createTestI18n().global;

const ENV: SettingsEnvironment = { isFeatureEnabled: () => true, isDesktop: false, role: 'owner' };
const ADMIN_ENV: AdminEnvironment = {
	isFeatureEnabled: () => true,
	isPlatformAdmin: true,
	hasPlugins: true,
	hasRampStarted: true,
};

const admin: SettingsSearchInput = {
	youSections: settingsSectionsFor(ENV),
	adminAreas: adminAreasFor(ADMIN_ENV),
	environment: ENV,
	adminEnvironment: ADMIN_ENV,
	t: (key) => t(key),
};
/** A member's sidebar has no Workspace tab, so no admin areas. */
const member: SettingsSearchInput = {
	...admin,
	adminAreas: [],
	environment: { ...ENV, role: 'editor' },
};

describe('settingsSearchResults', () => {
	it('finds the Appearance control on General for "dark mode"', () => {
		const results = settingsSearchResults(admin, 'dark mode');
		expect(results).toContainEqual(
			expect.objectContaining({
				title: 'Appearance',
				group: 'General',
				path: '/dashboard/preferences#appearance',
			})
		);
	});

	it('finds Vacation auto-reply by its synonym "out of office"', () => {
		const [first] = settingsSearchResults(admin, 'out of office');
		expect(first).toMatchObject({
			title: 'Vacation auto-reply',
			path: '/dashboard/preferences/vacation',
		});
	});

	it('finds a page by its description', () => {
		const results = settingsSearchResults(admin, 'auto-reply while away');
		expect(results.map((r) => r.path)).toContain('/dashboard/preferences/vacation');
	});

	it('lists page matches before control matches', () => {
		const results = settingsSearchResults(admin, 'signature');
		const firstControl = results.findIndex((r) => r.path.includes('#'));
		const lastPage = results.findLastIndex((r) => !r.path.includes('#'));
		expect(lastPage).toBeGreaterThanOrEqual(0);
		expect(firstControl).toBeGreaterThan(lastPage);
	});

	it('offers a workspace control to an admin', () => {
		const results = settingsSearchResults(admin, 'dkim');
		expect(results.map((r) => r.path)).toContain(
			'/dashboard/admin/delivery/domains#sending-domain-list'
		);
	});

	it('offers a member no workspace page or control', () => {
		for (const query of ['dkim', 'webhook secret', 'team']) {
			const results = settingsSearchResults(member, query);
			expect(results.filter((r) => r.path.startsWith('/dashboard/admin'))).toEqual([]);
		}
	});

	it('leaves out a control the viewer cannot reach', () => {
		const noMail: SettingsSearchInput = {
			...member,
			environment: {
				...member.environment,
				isFeatureEnabled: (flag) => flag !== 'postbox' && flag !== 'mail.external',
			},
		};
		expect(settingsSearchResults(noMail, 'auto-advance')).toEqual([]);
	});

	it('caps the list', () => {
		expect(settingsSearchResults(admin, 'e')).toHaveLength(SETTINGS_SEARCH_CAP);
	});

	it('answers an empty query with nothing', () => {
		expect(settingsSearchResults(admin, '   ')).toEqual([]);
	});
});
