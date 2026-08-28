/**
 * The settings registry as data.
 *
 * The registry exists because four hand-maintained tables had drifted apart, so
 * the assertions that matter here are the structural ones: every Preferences
 * PAGE on disk has an entry, every entry's title/description/keywords resolve to
 * real copy, gates hide the right things on an instance without mail or without
 * a desktop app, and a control deep-links to an anchor its own page declares.
 */
import { readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
	SETTINGS_REGISTRY,
	SETTINGS_ROOT,
	SETTINGS_SECTIONS,
	filterByKeywords,
	parseKeywords,
	settingsControlTargets,
	settingsEntryFor,
	settingsSectionsFor,
	visibleSettingsEntries,
	type SettingsEnvironment,
} from '../settingsRegistry';
import { createTestI18n } from '~/__tests__/i18n';

const { t, te } = createTestI18n().global;

const here = dirname(fileURLToPath(import.meta.url));
const preferencesPages = join(here, '../../pages/dashboard/preferences');

const FULL: SettingsEnvironment = { isFeatureEnabled: () => true, isDesktop: true };
const NO_MAIL: SettingsEnvironment = {
	isFeatureEnabled: (flag) => flag !== 'postbox' && flag !== 'mail.external',
	isDesktop: false,
};
const NO_AI: SettingsEnvironment = { isFeatureEnabled: (flag) => flag !== 'ai', isDesktop: false };

/** Every non-dynamic `.vue` page under `pages/dashboard/preferences`, as a route. */
async function preferenceRoutes(): Promise<string[]> {
	const walk = async (directory: string): Promise<string[]> => {
		const entries = await readdir(directory, { withFileTypes: true });
		const nested = await Promise.all(
			entries.map((entry) => {
				const full = join(directory, entry.name);
				if (entry.isDirectory()) return walk(full);
				if (!entry.name.endsWith('.vue') || entry.name.startsWith('__')) return [];
				return [full];
			})
		);
		return nested.flat();
	};
	return (await walk(preferencesPages))
		.map((file) =>
			`${SETTINGS_ROOT}/${relative(preferencesPages, file)
				.replace(/\\/g, '/')
				.replace(/\.vue$/, '')}`.replace(/\/index$/, '')
		)
		.filter((route) => !route.includes('['))
		.sort();
}

describe('SETTINGS_REGISTRY — coverage', () => {
	it('has an entry for every Preferences page on disk', async () => {
		const declared = new Set(SETTINGS_REGISTRY.map((entry) => entry.path));
		const undeclared = (await preferenceRoutes()).filter((route) => !declared.has(route));
		expect(undeclared).toEqual([]);
	});

	it('declares no entry without a page (every path is under the Preferences root)', () => {
		const stray = SETTINGS_REGISTRY.filter(
			(entry) => entry.path !== SETTINGS_ROOT && !entry.path.startsWith(`${SETTINGS_ROOT}/`)
		);
		expect(stray).toEqual([]);
	});

	it('uses a unique id and path per entry', () => {
		expect(new Set(SETTINGS_REGISTRY.map((entry) => entry.id)).size).toBe(SETTINGS_REGISTRY.length);
		expect(new Set(SETTINGS_REGISTRY.map((entry) => entry.path)).size).toBe(
			SETTINGS_REGISTRY.length
		);
	});

	it('assigns every entry to a declared section', () => {
		const known = new Set(SETTINGS_SECTIONS.map((section) => section.key));
		expect(SETTINGS_REGISTRY.filter((entry) => !known.has(entry.section))).toEqual([]);
	});

	it('resolves every title, description and keyword list to real copy', () => {
		const missing: string[] = [];
		for (const key of SETTINGS_SECTIONS.map((section) => section.titleKey)) {
			if (!te(key)) missing.push(key);
		}
		for (const entry of SETTINGS_REGISTRY) {
			for (const key of [entry.titleKey, entry.descriptionKey, entry.keywordsKey]) {
				if (!te(key)) missing.push(key);
			}
			for (const control of entry.controls ?? []) {
				for (const key of [control.titleKey, control.keywordsKey]) {
					if (!te(key)) missing.push(key);
				}
			}
		}
		expect(missing).toEqual([]);
	});

	it('gives every control at least one searchable synonym', () => {
		const bare = settingsControlTargets(FULL)
			.filter((target) => parseKeywords(t(target.control.keywordsKey)).length === 0)
			.map((target) => target.id);
		expect(bare).toEqual([]);
	});

	it('names the pages the palette had lost', () => {
		const paths = visibleSettingsEntries(FULL).map((entry) => entry.path);
		expect(paths).toEqual(
			expect.arrayContaining([
				`${SETTINGS_ROOT}/aliases`,
				`${SETTINGS_ROOT}/vacation`,
				`${SETTINGS_ROOT}/snippets`,
				`${SETTINGS_ROOT}/writing-voice`,
				`${SETTINGS_ROOT}/app-passwords`,
			])
		);
	});
});

describe('gates', () => {
	it('keeps a no-mail instance on the pages that are not about mail', () => {
		expect(visibleSettingsEntries(NO_MAIL).map((entry) => entry.id)).toEqual([
			'overview',
			'account',
			'security',
		]);
	});

	it('hides the writing voice when AI is off but mail is on', () => {
		expect(visibleSettingsEntries(NO_AI).map((entry) => entry.id)).not.toContain('writingVoice');
		expect(visibleSettingsEntries(NO_AI).map((entry) => entry.id)).toContain('snippets');
	});

	it('leaves a hidden entry reachable but unlisted', () => {
		expect(visibleSettingsEntries(FULL).map((entry) => entry.id)).not.toContain('addAccount');
		expect(settingsEntryFor(`${SETTINGS_ROOT}/add-account`)?.hidden).toBe(true);
	});

	it('drops empty sections rather than rendering an empty heading', () => {
		expect(settingsSectionsFor(NO_MAIL).map((section) => section.key)).toEqual([
			'general',
			'account',
		]);
		expect(settingsSectionsFor(FULL).map((section) => section.key)).toEqual([
			'general',
			'mail',
			'account',
		]);
	});
});

describe('settingsControlTargets', () => {
	it('deep-links each control to an anchor on its own page', () => {
		for (const target of settingsControlTargets(FULL)) {
			expect(target.href).toBe(`${target.entry.path}#${target.control.anchor}`);
		}
	});

	it('drops every control of a page the environment cannot reach', () => {
		const ids = settingsControlTargets(NO_MAIL).map((target) => target.control.id);
		expect(ids).toEqual(['appearance', 'language']);
	});
});

describe('filterByKeywords', () => {
	const rows = [
		{ label: 'Appearance', subtitle: 'General', keywords: ['dark mode', 'theme'] },
		{ label: 'Density', subtitle: 'General', keywords: ['compact'] },
	];

	it('returns everything, in order, for an empty query', () => {
		expect(filterByKeywords(rows, '  ')).toEqual(rows);
	});

	it('finds a row by a synonym its label never contains', () => {
		expect(filterByKeywords(rows, 'dark').map((row) => row.label)).toEqual(['Appearance']);
	});

	it('ranks a label hit above another row keyword hit', () => {
		const ranked = filterByKeywords(
			[
				{ label: 'Theme colours', subtitle: '', keywords: [] },
				{ label: 'Appearance', subtitle: '', keywords: ['theme'] },
			],
			'theme'
		);
		expect(ranked.map((row) => row.label)).toEqual(['Theme colours', 'Appearance']);
	});

	it('drops a row that matches nowhere', () => {
		expect(filterByKeywords(rows, 'zzzz')).toEqual([]);
	});
});

describe('parseKeywords', () => {
	it('splits on commas and trims, dropping empties', () => {
		expect(parseKeywords(' dark mode ,, theme,')).toEqual(['dark mode', 'theme']);
	});
});
