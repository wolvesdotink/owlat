import { describe, expect, it } from 'vitest';
import {
	isSafeInternalNavPath,
	parsePluginId,
	PLUGIN_NAV_ITEM_CAPABILITY,
	PLUGIN_SETTINGS_PANEL_CAPABILITY,
	pluginNavItemKind,
	pluginSettingsPanelKind,
	validatePluginManifest,
	type PluginManifestIssue,
} from '../index';

function issuesFor(value: unknown): readonly PluginManifestIssue[] {
	const result = validatePluginManifest(value);
	return result.ok ? [] : result.issues;
}

function navBase(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: 'deals-nav',
		version: '1.0.0',
		capabilities: [PLUGIN_NAV_ITEM_CAPABILITY],
		flag: { default: false },
		contributes: {
			navItems: [
				{
					id: 'pipeline',
					section: 'audience',
					name: 'Pipeline',
					href: '/dashboard/audience/pipeline',
					icon: 'lucide:kanban',
				},
			],
		},
		...overrides,
	};
}

function settingsBase(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: 'deals-settings',
		version: '1.0.0',
		capabilities: [PLUGIN_SETTINGS_PANEL_CAPABILITY],
		flag: { default: false },
		contributes: {
			settingsPanels: [
				{
					id: 'sync',
					name: 'Sync settings',
					href: '/dashboard/settings/deals',
					icon: 'lucide:refresh-ccw',
				},
			],
		},
		...overrides,
	};
}

function withNavItem(patch: Record<string, unknown>): Record<string, unknown> {
	return navBase({
		contributes: {
			navItems: [
				{
					id: 'pipeline',
					section: 'audience',
					name: 'Pipeline',
					href: '/dashboard/audience/pipeline',
					icon: 'lucide:kanban',
					...patch,
				},
			],
		},
	});
}

describe('plugin nav item contributions', () => {
	it('namespaces every plugin nav item under its owning plugin id', () => {
		expect(pluginNavItemKind(parsePluginId('deals-nav'), 'pipeline')).toBe(
			'plugin.deals-nav.pipeline'
		);
	});

	it('accepts a well-formed nav-item manifest', () => {
		expect(validatePluginManifest(navBase()).ok).toBe(true);
	});

	it('requires the ui:navigation capability when nav items are contributed', () => {
		expect(issuesFor(navBase({ capabilities: [] })).some((i) => i.path === '$.capabilities')).toBe(
			true
		);
	});

	it('requires a flag when nav items are contributed', () => {
		const manifest = navBase();
		delete (manifest as { flag?: unknown }).flag;
		expect(issuesFor(manifest).some((i) => i.path === '$.flag')).toBe(true);
	});

	it('rejects a nav item without a target section', () => {
		const manifest = navBase({
			contributes: {
				navItems: [
					{ id: 'pipeline', name: 'Pipeline', href: '/dashboard/x', icon: 'lucide:kanban' },
				],
			},
		});
		expect(issuesFor(manifest).some((i) => i.path.endsWith('.section'))).toBe(true);
	});

	it('rejects an external or scripted href', () => {
		for (const href of [
			'https://evil.example/steal',
			'//evil.example',
			'javascript:alert(1)',
			'dashboard/no-leading-slash',
			'/dashboard/x y',
		]) {
			expect(issuesFor(withNavItem({ href })).some((i) => i.path.endsWith('.href'))).toBe(true);
		}
	});

	it('rejects a traversal href that aliases a core destination', () => {
		expect(
			issuesFor(withNavItem({ href: '/dashboard/audience/contacts/../contacts' })).some((i) =>
				i.path.endsWith('.href')
			)
		).toBe(true);
	});

	it('rejects a trailing-slash href that aliases a core destination', () => {
		expect(
			issuesFor(withNavItem({ href: '/dashboard/audience/contacts/' })).some((i) =>
				i.path.endsWith('.href')
			)
		).toBe(true);
	});

	it('rejects a malformed icon token', () => {
		expect(
			issuesFor(withNavItem({ icon: 'not an icon' })).some((i) => i.path.endsWith('.icon'))
		).toBe(true);
	});

	it('rejects a blank or oversized name', () => {
		expect(issuesFor(withNavItem({ name: '   ' })).some((i) => i.path.endsWith('.name'))).toBe(
			true
		);
		expect(
			issuesFor(withNavItem({ name: 'x'.repeat(65) })).some((i) => i.path.endsWith('.name'))
		).toBe(true);
	});

	it('bounds the name by UTF-16 code units, not by code points', () => {
		// The render-side clamp (`clampLabel` in apps/web) slices at 64 code UNITS,
		// so the manifest ceiling must count the same unit or the two layers
		// disagree and the documented budget is fiction. 33 astral characters are
		// 33 code points but 66 code units, so they are over the ceiling; 32 are
		// exactly at it and pass through the render clamp untouched.
		const astral = String.fromCodePoint(0x1f600);
		expect(astral.length).toBe(2);
		expect(
			issuesFor(withNavItem({ name: astral.repeat(33) })).some((i) => i.path.endsWith('.name'))
		).toBe(true);
		expect(
			issuesFor(withNavItem({ name: astral.repeat(32) })).some((i) => i.path.endsWith('.name'))
		).toBe(false);
	});

	it('rejects a name that is empty once control/format characters are stripped', () => {
		// A control-only name survives trim() but renders as a blank, unlabelled link.
		expect(
			issuesFor(withNavItem({ name: String.fromCharCode(7) })).some((i) => i.path.endsWith('.name'))
		).toBe(true);
	});

	it('rejects a negative or non-integer order', () => {
		expect(issuesFor(withNavItem({ order: -1 })).some((i) => i.path.endsWith('.order'))).toBe(true);
		expect(issuesFor(withNavItem({ order: 1.5 })).some((i) => i.path.endsWith('.order'))).toBe(
			true
		);
	});

	it('accepts a valid non-negative integer order', () => {
		expect(validatePluginManifest(withNavItem({ order: 3 })).ok).toBe(true);
	});

	it('rejects duplicate nav item ids and unknown fields', () => {
		const manifest = navBase({
			contributes: {
				navItems: [
					{ id: 'x', section: 'audience', name: 'A', href: '/dashboard/a', icon: 'lucide:a' },
					{ id: 'x', section: 'audience', name: 'B', href: '/dashboard/b', icon: 'lucide:b' },
				],
			},
		});
		expect(issuesFor(manifest).some((i) => i.code === 'duplicate')).toBe(true);
		expect(issuesFor(withNavItem({ rogue: true })).some((i) => i.code === 'unknown_field')).toBe(
			true
		);
	});
});

describe('plugin settings panel contributions', () => {
	it('namespaces every plugin settings entry under its owning plugin id', () => {
		expect(pluginSettingsPanelKind(parsePluginId('deals-settings'), 'sync')).toBe(
			'plugin.deals-settings.sync'
		);
	});

	it('accepts a well-formed settings-panel manifest', () => {
		expect(validatePluginManifest(settingsBase()).ok).toBe(true);
	});

	it('requires the ui:settings capability when settings panels are contributed', () => {
		expect(
			issuesFor(settingsBase({ capabilities: [] })).some((i) => i.path === '$.capabilities')
		).toBe(true);
	});

	it('does not accept a section field on a settings panel', () => {
		const manifest = settingsBase({
			contributes: {
				settingsPanels: [
					{
						id: 'sync',
						section: 'settings',
						name: 'Sync',
						href: '/dashboard/settings/deals',
						icon: 'lucide:refresh-ccw',
					},
				],
			},
		});
		expect(issuesFor(manifest).some((i) => i.path.endsWith('.section'))).toBe(true);
	});

	it('rejects an external settings href', () => {
		const manifest = settingsBase({
			contributes: {
				settingsPanels: [
					{ id: 'sync', name: 'Sync', href: 'https://evil.example', icon: 'lucide:x' },
				],
			},
		});
		expect(issuesFor(manifest).some((i) => i.path.endsWith('.href'))).toBe(true);
	});
});

describe('isSafeInternalNavPath', () => {
	it('accepts absolute internal paths', () => {
		expect(isSafeInternalNavPath('/dashboard/settings')).toBe(true);
		expect(isSafeInternalNavPath('/dashboard/settings/team-inboxes')).toBe(true);
		expect(isSafeInternalNavPath('/')).toBe(true);
	});

	it('rejects non-string, relative, protocol-relative and scripted values', () => {
		expect(isSafeInternalNavPath(42)).toBe(false);
		expect(isSafeInternalNavPath('')).toBe(false);
		expect(isSafeInternalNavPath('dashboard')).toBe(false);
		expect(isSafeInternalNavPath('//evil.example')).toBe(false);
		expect(isSafeInternalNavPath('javascript:alert(1)')).toBe(false);
		expect(isSafeInternalNavPath('/a b')).toBe(false);
		expect(isSafeInternalNavPath(`/${'x'.repeat(300)}`)).toBe(false);
	});

	it('rejects non-canonical dot-only path segments', () => {
		expect(isSafeInternalNavPath('/a/../b')).toBe(false);
		expect(isSafeInternalNavPath('/a/./b')).toBe(false);
		expect(isSafeInternalNavPath('/..')).toBe(false);
		expect(isSafeInternalNavPath('/.')).toBe(false);
		expect(isSafeInternalNavPath('/dashboard/../login')).toBe(false);
	});

	it('rejects trailing-slash and uppercase aliases of a core destination', () => {
		// vue-router's lenient defaults resolve both of these to the core route,
		// but as different strings they would evade the href-based no-shadow dedup.
		expect(isSafeInternalNavPath('/dashboard/audience/contacts/')).toBe(false);
		expect(isSafeInternalNavPath('/DASHBOARD/audience/contacts')).toBe(false);
	});

	it('still accepts dots inside an otherwise well-formed segment', () => {
		expect(isSafeInternalNavPath('/dashboard/v1.2/report')).toBe(true);
	});
});
