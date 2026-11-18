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

const env = (
	flags: string[],
	isDesktop = false,
	role: SettingsEnvironment['role'] = 'owner'
): SettingsEnvironment => ({
	isFeatureEnabled: (flag) => flags.includes(flag),
	isDesktop,
	role,
});
const EVERYTHING = env(
	[
		'postbox',
		'mail.external',
		'inbox',
		'chat',
		'ai.assistant',
		'ai.knowledge',
		'campaigns',
		'automations',
		'transactional',
	],
	true
);
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
			'chatComposer',
			'inbox',
			'inboxList',
			'review',
			'workbench',
			'peek',
			'answer',
			'answerQueue',
			'askCard',
			'mailCard',
			'teamCard',
			'mentionCard',
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

	it('shows each Answer queue card where its source exists', () => {
		const scopes = (flags: string[]) => sections(env(flags)).map((section) => section.scope);
		expect(scopes(['inbox'])).toEqual(expect.arrayContaining(['teamCard', 'inboxList']));
		expect(scopes(['inbox'])).not.toContain('mailCard');
		expect(scopes(['inbox'])).not.toContain('mentionCard');
		expect(scopes(['postbox'])).toContain('mailCard');
		expect(scopes(['chat'])).toEqual(expect.arrayContaining(['answerQueue', 'mentionCard']));
		expect(scopes(['chat'])).not.toContain('askCard');
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

	it('lists the message-box recall keys where Chat or the Assistant exists', () => {
		const ids = (flags: string[]) =>
			sections(env(flags))
				.filter((section) => section.scope === 'chatComposer')
				.flatMap((section) => section.rows.map((row) => row.def.id));
		expect(ids(['chat'])).toEqual(['chatComposer.recallOlder']);
		expect(ids(['ai.assistant'])).toEqual(['chatComposer.recallOlder', 'chatComposer.recallNewer']);
		expect(ids(['inbox'])).toEqual([]);
	});

	it('hides the Ask chord while knowledge is off', () => {
		expect(isShortcutEntryAvailable({ id: 'global.ask', scope: 'global' }, NO_MAIL)).toBe(false);
		expect(
			isShortcutEntryAvailable({ id: 'global.ask', scope: 'global' }, env(['ai.knowledge']))
		).toBe(true);
	});

	// A `g` chord answers to the gate its destination has in the navigation
	// table, so nobody is shown a key that only bounces them to the Workbench.
	it('offers each go-to chord only where its destination is in the navigation', () => {
		const goTo = (environment: SettingsEnvironment) =>
			SHORTCUT_CATALOG.filter(
				(def) => def.groupKey === 'shared.shortcuts.groups.navigation' && def.scope === 'global'
			)
				.filter((def) => isShortcutEntryAvailable(def, environment))
				.map((def) => def.id);
		const flags = ['postbox', 'campaigns', 'automations', 'transactional'];

		expect(goTo(env(flags))).toEqual([
			'global.goToDashboard',
			'global.goToAnswer',
			'global.goToContacts',
			'global.goToEmails',
			'global.goToCampaigns',
			'global.goToAutomations',
			'global.goToTransactional',
			'global.goToAdmin',
		]);
		// An editor has no templates, automations, transactional or workspace settings.
		expect(goTo(env(flags, false, 'editor'))).toEqual([
			'global.goToDashboard',
			'global.goToAnswer',
			'global.goToContacts',
			'global.goToCampaigns',
		]);
		// A feature that is off takes its chord with it, the Answer queue with mail.
		expect(goTo(env(['transactional']))).toEqual([
			'global.goToDashboard',
			'global.goToContacts',
			'global.goToEmails',
			'global.goToTransactional',
			'global.goToAdmin',
		]);
		// The role is unknown until it loads: fail closed, as the sidebar does.
		expect(goTo(env(flags, false, null))).not.toContain('global.goToAdmin');
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
