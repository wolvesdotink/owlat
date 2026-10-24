/**
 * The Workspace controls the palette indexes.
 *
 * What has to hold: a member is offered none of them whatever the deployment
 * has (the admin environment carries no role, so the role check is the
 * caller's argument); a control disappears with its page's gate, its parent's
 * included; every anchor is an id its own page actually renders; every title
 * and synonym list exists in both catalogs; and a deep link's hash is honoured
 * only when the page it lands on declares that anchor.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import en from '../../../i18n/locales/en.json';
import de from '../../../i18n/locales/de.json';
import {
	ADMIN_SETTINGS_CONTROLS,
	adminAnchorFromHash,
	adminControlTargets,
} from '../adminSettingsControls';
import { adminEntryById, type AdminEnvironment } from '../adminSettingsRegistry';
import { filterByKeywords, parseKeywords } from '../settingsRegistry';
import { createTestI18n } from '~/__tests__/i18n';

const { t } = createTestI18n().global;
const here = dirname(fileURLToPath(import.meta.url));
const pagesRoot = join(here, '../../pages');

const FULL: AdminEnvironment = {
	isFeatureEnabled: () => true,
	isPlatformAdmin: true,
	hasPlugins: true,
	hasRampStarted: true,
};

const ids = (env: AdminEnvironment, canAdminister = true) =>
	adminControlTargets(env, canAdminister).map((target) => target.control.id);

function lookup(catalog: unknown, key: string): unknown {
	return key.split('.').reduce<unknown>((node, part) => {
		return node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined;
	}, catalog);
}

describe('admin settings controls', () => {
	it('indexes the six anchored admin topics', () => {
		expect(ids(FULL)).toEqual([
			'dkim',
			'aiProviderKey',
			'autonomy',
			'rampPace',
			'webhookSecret',
			'brandColors',
		]);
	});

	it('offers a member nothing, even on a deployment that has every page', () => {
		expect(adminControlTargets(FULL, false)).toEqual([]);
	});

	it('takes a control away with its page gate', () => {
		const noAi: AdminEnvironment = { ...FULL, isFeatureEnabled: (flag) => flag !== 'ai' };
		expect(ids(noAi)).not.toContain('autonomy');
		// The provider page is where AI gets turned on, so its key stays findable.
		expect(ids(noAi)).toContain('aiProviderKey');
	});

	it("takes a tab's control away with its parent's gate", () => {
		// Ramp controls is a hidden child of Advanced, listed once the ramp started.
		expect(ids({ ...FULL, hasRampStarted: false })).not.toContain('rampPace');
	});

	it('deep-links each control to its page and anchor', () => {
		const brand = adminControlTargets(FULL, true).find(
			(target) => target.control.id === 'brandColors'
		);
		expect(brand?.href).toBe('/dashboard/admin/instance/brand-kit#brand-colors');
		expect(brand?.id).toBe('admin:brandKit:brandColors');
	});

	it.each(ADMIN_SETTINGS_CONTROLS.map((control) => [control.id, control] as const))(
		'%s points at an id its own page renders',
		async (_id, control) => {
			const entry = adminEntryById(control.entryId);
			expect(entry, `no admin entry ${control.entryId}`).toBeDefined();
			const file = join(pagesRoot, `${entry!.path.replace(/^\//, '')}.vue`);
			const source = await readFile(file, 'utf8');
			expect(source).toContain(`id="${control.anchor}"`);
		}
	);

	it.each(ADMIN_SETTINGS_CONTROLS.map((control) => [control.id, control] as const))(
		'%s has a title and synonyms in every catalog',
		(_id, control) => {
			for (const catalog of [en, de]) {
				expect(typeof lookup(catalog, control.titleKey)).toBe('string');
				const keywords = lookup(catalog, control.keywordsKey);
				expect(typeof keywords).toBe('string');
				expect(parseKeywords(keywords as string).length).toBeGreaterThan(2);
			}
		}
	);

	it('is found by the words an admin types', () => {
		const rows = adminControlTargets(FULL, true).map((target) => ({
			id: target.control.id,
			label: t(target.control.titleKey),
			subtitle: t(target.entry.titleKey),
			keywords: parseKeywords(t(target.control.keywordsKey)),
		}));
		const first = (query: string) => filterByKeywords(rows, query)[0]?.id;
		expect(first('dkim')).toBe('dkim');
		expect(first('api key')).toBe('aiProviderKey');
		expect(first('autonomy')).toBe('autonomy');
		expect(first('warm-up')).toBe('rampPace');
		expect(first('webhook secret')).toBe('webhookSecret');
		expect(first('brand colors')).toBe('brandColors');
	});
});

describe('adminAnchorFromHash', () => {
	it("honours an anchor the page's own control declares", () => {
		expect(adminAnchorFromHash('/dashboard/admin/instance/brand-kit', '#brand-colors')).toBe(
			'brand-colors'
		);
	});

	it('ignores an anchor declared for another page', () => {
		expect(adminAnchorFromHash('/dashboard/admin/delivery/webhooks', '#brand-colors')).toBeNull();
	});

	it('ignores an arbitrary element id and an empty hash', () => {
		expect(adminAnchorFromHash('/dashboard/admin/instance/brand-kit', '#__nuxt')).toBeNull();
		expect(adminAnchorFromHash('/dashboard/admin/instance/brand-kit', '')).toBeNull();
		expect(adminAnchorFromHash('/dashboard/admin/instance/brand-kit', '#')).toBeNull();
	});
});
