import { describe, expect, it } from 'vitest';
import { buildShortcutBindings } from '../shortcutRegistry';
import { SHORTCUT_CATALOG } from '../shortcutCatalog';
import {
	clashesById,
	isShortcutEntryAvailable,
	isShortcutScopeAvailable,
	matchesShortcutFilter,
	shortcutSettingsSections,
} from '../shortcutSettingsRows';
import type { SettingsEnvironment } from '~/lib/settingsRegistry';

const env = (flags: string[], isDesktop = false): SettingsEnvironment => ({
	isFeatureEnabled: (flag) => flags.includes(flag),
	isDesktop,
});
const EVERYTHING = env(['postbox', 'mail.external', 'inbox', 'ai.assistant'], true);
const NO_MAIL = env(['inbox']);

function sections(environment: SettingsEnvironment, query = '', overridden: string[] = []) {
	return shortcutSettingsSections(SHORTCUT_CATALOG, buildShortcutBindings(SHORTCUT_CATALOG), {
		env: environment,
		overridden: new Set(overridden),
		query,
		describe: (def, chords) => [def.id, ...chords],
	});
}

describe('shortcut page sections', () => {
	it('lists every scope, app-wide first, on a fully featured desktop instance', () => {
		expect(sections(EVERYTHING).map((section) => section.scope)).toEqual([
			'global',
			'postbox',
			'composer',
			'inbox',
			'review',
			'workbench',
			'peek',
			'answer',
			'workspace',
		]);
	});

	it('lists every catalog entry once on that instance', () => {
		const ids = sections(EVERYTHING).flatMap((section) => section.rows.map((row) => row.def.id));
		expect([...ids].sort()).toEqual(SHORTCUT_CATALOG.map((def) => def.id).sort());
	});

	it('drops the Postbox and the desktop workspaces where they do not exist', () => {
		const scopes = sections(NO_MAIL).map((section) => section.scope);
		expect(scopes).not.toContain('postbox');
		expect(scopes).not.toContain('workspace');
		expect(scopes).toContain('global');
		expect(scopes).toContain('inbox');
	});

	it('hides the Assistant chord while the Assistant is off', () => {
		expect(isShortcutEntryAvailable({ id: 'global.assistant', scope: 'global' }, NO_MAIL)).toBe(
			false
		);
		expect(isShortcutEntryAvailable({ id: 'global.settings', scope: 'global' }, NO_MAIL)).toBe(
			true
		);
		expect(isShortcutScopeAvailable('answer', env([]))).toBe(false);
	});

	it('marks fixed and changed rows', () => {
		const rows = sections(EVERYTHING, '', ['global.settings']).flatMap((s) => s.rows);
		const row = (id: string) => rows.find((r) => r.def.id === id);
		expect(row('global.settings')).toMatchObject({ fixed: false, overridden: true });
		expect(row('global.commandPalette')).toMatchObject({ fixed: true, overridden: false });
	});

	it('filters by any word of the label, scope or chord, ignoring case', () => {
		const ids = sections(EVERYTHING, 'GLOBAL.SETT').flatMap((s) => s.rows.map((r) => r.def.id));
		expect(ids).toEqual(['global.settings']);
		expect(sections(EVERYTHING, 'nothing-matches-this')).toEqual([]);
	});
});

describe('matchesShortcutFilter', () => {
	it('needs every word somewhere', () => {
		expect(matchesShortcutFilter(['Go to drafts', 'g d'], 'go draft')).toBe(true);
		expect(matchesShortcutFilter(['Go to drafts', 'g d'], 'go sent')).toBe(false);
		expect(matchesShortcutFilter(['Archive'], '   ')).toBe(true);
	});
});

describe('clashesById', () => {
	it('names the other side of every clash, once', () => {
		const clashes = clashesById([
			{ scope: 'global', chord: 'x', ids: ['a', 'b', 'c'] },
			{ scope: 'global', chord: 'y', ids: ['a', 'b'], kind: 'prefix' },
		]);
		expect(clashes.get('a')).toEqual(['b', 'c']);
		expect(clashes.get('c')).toEqual(['a', 'b']);
	});
});
