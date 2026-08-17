import { describe, expect, it } from 'vitest';
import { composeBundledPlugins, mergeHostedNavigation } from '@owlat/plugin-host';
import { definePlugin, parsePluginId } from '@owlat/plugin-kit';
import type { FeatureFlagKey } from '@owlat/shared/featureFlags';
import {
	buildNavigationSections,
	derivePluginNavigation,
	type PluginNavigationContributions,
} from '../dashboardNavigation';
import { createTestI18n } from '~/__tests__/i18n';

/**
 * Core destination names are catalog keys (module scope never calls `useI18n`);
 * a plugin-contributed name is the manifest's own words and passes through `t()`
 * untouched. The sidebar renders both through this one boundary.
 */
const { t } = createTestI18n().global;
describe('buildNavigationSections — role-aware information architecture', () => {
	const allFlags = { isFeatureEnabled: () => true, isDesktop: false };

	it('shows owners the complete administrative information architecture', () => {
		const sections = buildNavigationSections({ ...allFlags, role: 'owner' });
		expect(sections.map((section) => section.key)).toEqual([
			'inbox',
			'postbox',
			'chat',
			'assistant',
			'send',
			'audience',
			'knowledge',
			'administration',
			'preferences',
		]);
		expect(
			sections.find((section) => section.key === 'administration')?.items.map((item) => item.href)
		).toEqual([
			'/dashboard/admin',
			'/dashboard/admin/delivery',
			'/dashboard/admin/team',
			'/dashboard/admin/instance',
		]);
	});

	it('gives editors a customer-first surface with no administrative destinations', () => {
		const sections = buildNavigationSections({ ...allFlags, role: 'editor' });
		const hrefs = sections.flatMap((section) => section.items.map((item) => item.href));
		expect(sections.map((section) => section.key)).toEqual([
			'inbox',
			'postbox',
			'send',
			'audience',
			'preferences',
		]);
		const audienceSection = sections.find((section) => section.key === 'audience');
		expect(t(audienceSection?.name ?? '')).toBe('Customers');
		expect(audienceSection).toMatchObject({ href: '/dashboard/audience/contacts' });
		expect(hrefs).not.toContain('/dashboard/admin');
		expect(hrefs.some((href) => href.startsWith('/dashboard/admin/'))).toBe(false);
		expect(hrefs).not.toContain('/dashboard/automations');
		expect(hrefs).not.toContain('/dashboard/send/transactional');
	});

	it('fails closed while the organization role is unresolved', () => {
		const sections = buildNavigationSections({ ...allFlags, role: null });
		expect(sections.some((section) => section.key === 'administration')).toBe(false);
	});
});

const alwaysOn = { isFeatureEnabled: () => true, isDesktop: false, role: 'owner' as const };

function contributions(
	over: Partial<PluginNavigationContributions>
): PluginNavigationContributions {
	return { navItems: [], settingsPanels: [], ...over };
}

function pluginNav(
	pluginId: string,
	section: string,
	href: string,
	over: Record<string, unknown> = {}
) {
	return {
		pluginId: parsePluginId(pluginId),
		section,
		id: href,
		order: 0,
		enabled: true,
		value: { name: href, href, icon: 'lucide:box' },
		...over,
	};
}

describe('buildNavigationSections — plugin contributions', () => {
	it('appends an enabled plugin nav item after every core item in its section', () => {
		const sections = buildNavigationSections(
			alwaysOn,
			contributions({ navItems: [pluginNav('deals', 'audience', '/dashboard/audience/pipeline')] })
		);
		const audience = sections.find((s) => s.key === 'audience');
		expect(audience?.items.at(-1)?.href).toBe('/dashboard/audience/pipeline');
		expect(audience?.items.map((i) => i.href).slice(0, 5)).toEqual([
			'/dashboard/audience',
			'/dashboard/audience/contacts',
			'/dashboard/audience/topics',
			'/dashboard/audience/segments',
			'/dashboard/audience/suppressions',
		]);
	});

	it('drops a disabled plugin nav item (feature-off)', () => {
		const sections = buildNavigationSections(
			alwaysOn,
			contributions({
				navItems: [
					pluginNav('deals', 'audience', '/dashboard/audience/pipeline', { enabled: false }),
				],
			})
		);
		const hrefs = sections.find((s) => s.key === 'audience')?.items.map((i) => i.href);
		expect(hrefs).not.toContain('/dashboard/audience/pipeline');
	});

	it('drops a plugin item targeting an unknown section (fail-closed)', () => {
		const sections = buildNavigationSections(
			alwaysOn,
			contributions({ navItems: [pluginNav('deals', 'not-a-section', '/dashboard/x')] })
		);
		expect(sections.flatMap((s) => s.items.map((i) => i.href))).not.toContain('/dashboard/x');
	});

	it.each([
		['settings', '/dashboard/admin/legacy-settings-panel'],
		['delivery', '/dashboard/admin/delivery/legacy-warmup'],
	])('remaps a retired section key (%s) onto Administration', (section, href) => {
		// Both keys were valid targets before the IA restructure and the manifest
		// validator only checks that `section` is kebab-case, so a published
		// third-party plugin can still ship them. They must land in Administration
		// rather than be dropped by the fail-closed unknown-section filter.
		const sections = buildNavigationSections(
			alwaysOn,
			contributions({ navItems: [pluginNav('deals', section, href)] })
		);
		expect(sections.find((s) => s.key === 'administration')?.items.at(-1)?.href).toBe(href);
	});

	it('drops a plugin item whose target section is feature-off', () => {
		const env = {
			isFeatureEnabled: (f: FeatureFlagKey) => f !== 'ai.knowledge',
			isDesktop: false,
			role: 'owner' as const,
		};
		const sections = buildNavigationSections(
			env,
			contributions({ navItems: [pluginNav('deals', 'knowledge', '/dashboard/knowledge/deals')] })
		);
		expect(sections.some((s) => s.key === 'knowledge')).toBe(false);
		expect(sections.flatMap((s) => s.items.map((i) => i.href))).not.toContain(
			'/dashboard/knowledge/deals'
		);
	});

	it('lets a core destination win when a plugin claims the same href (no shadowing)', () => {
		const sections = buildNavigationSections(
			alwaysOn,
			contributions({
				navItems: [
					pluginNav('evil', 'audience', '/dashboard/audience/contacts', {
						value: {
							name: 'Hijacked',
							href: '/dashboard/audience/contacts',
							icon: 'lucide:skull',
						},
					}),
				],
			})
		);
		const audience = sections.find((s) => s.key === 'audience');
		const contacts = audience?.items.find((i) => i.href === '/dashboard/audience/contacts');
		expect(t(contacts?.name ?? '')).toBe('Contacts');
		expect(audience?.items.filter((i) => i.href === '/dashboard/audience/contacts')).toHaveLength(
			1
		);
	});

	it('appends plugin settings panels to the Settings section', () => {
		const sections = buildNavigationSections(
			alwaysOn,
			contributions({
				settingsPanels: [
					{
						pluginId: parsePluginId('deals'),
						id: '/dashboard/admin/deals',
						order: 0,
						enabled: true,
						value: {
							name: 'Deals sync',
							href: '/dashboard/admin/deals',
							icon: 'lucide:refresh-ccw',
						},
					},
				],
			})
		);
		expect(sections.find((s) => s.key === 'administration')?.items.at(-1)?.href).toBe(
			'/dashboard/admin/deals'
		);
	});

	it('orders competing plugin items deterministically by plugin id', () => {
		const sections = buildNavigationSections(
			alwaysOn,
			contributions({
				navItems: [pluginNav('zeta', 'audience', '/z'), pluginNav('alpha', 'audience', '/a')],
			})
		);
		const tail = sections
			.find((s) => s.key === 'audience')
			?.items.slice(-2)
			.map((i) => i.href);
		expect(tail).toEqual(['/a', '/z']);
	});
});

describe('derivePluginNavigation', () => {
	function pluginFixture() {
		return composeBundledPlugins([
			{
				packageName: '@acme/deals',
				manifest: definePlugin({
					id: 'deals',
					version: '1.0.0',
					capabilities: ['ui:navigation', 'ui:settings'],
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
						settingsPanels: [
							{
								id: 'sync',
								name: 'Deals sync',
								href: '/dashboard/admin/deals',
								icon: 'lucide:refresh-ccw',
							},
						],
					},
				}),
			},
		]);
	}

	it('gates every contribution behind the plugin feature flag', () => {
		const plugins = pluginFixture();
		const enabled = derivePluginNavigation(plugins, (f) => f === 'plugin.deals');
		expect(enabled.navItems[0]?.enabled).toBe(true);
		expect(enabled.settingsPanels[0]?.enabled).toBe(true);

		const disabled = derivePluginNavigation(plugins, () => false);
		expect(disabled.navItems[0]?.enabled).toBe(false);
		expect(disabled.settingsPanels[0]?.enabled).toBe(false);
	});

	it('defaults the ordering hint to declaration order and carries the target section', () => {
		const derived = derivePluginNavigation(pluginFixture(), () => true);
		expect(derived.navItems[0]?.order).toBe(0);
		expect(derived.navItems[0]?.section).toBe('audience');
		expect(derived.navItems[0]?.id).toBe('/dashboard/audience/pipeline');
	});

	it('clamps whitespace in a plugin-authored label before rendering', () => {
		const plugins = composeBundledPlugins([
			{
				packageName: '@acme/rogue',
				manifest: definePlugin({
					id: 'rogue',
					version: '1.0.0',
					capabilities: ['ui:settings'],
					flag: { default: false },
					contributes: {
						settingsPanels: [
							{
								id: 'x',
								name: `Bad${String.fromCharCode(7)}Name${String.fromCharCode(0)}`,
								href: '/dashboard/admin/rogue',
								icon: 'lucide:x',
							},
						],
					},
				}),
			},
		]);
		expect(derivePluginNavigation(plugins, () => true).settingsPanels[0]?.value.name).toBe(
			'BadName'
		);
	});

	it('clamps the label by UTF-16 code units and never splits a surrogate pair', () => {
		// The clamp's unit is observable, and the docs state it: 32 astral
		// characters are 64 code units — exactly the ceiling the manifest
		// validator enforces — so the widest label an author can ship reaches the
		// sidebar whole. A code-POINT clamp would let twice that through, and a
		// code-unit clamp that cut mid-pair would leave a lone surrogate (U+FFFD
		// when rendered); neither happens.
		const label = String.fromCodePoint(0x1f600).repeat(32);
		expect(label.length).toBe(64);
		const plugins = composeBundledPlugins([
			{
				packageName: '@acme/astral',
				manifest: definePlugin({
					id: 'astral',
					version: '1.0.0',
					capabilities: ['ui:settings'],
					flag: { default: false },
					contributes: {
						settingsPanels: [
							{ id: 'x', name: label, href: '/dashboard/admin/astral', icon: 'lucide:x' },
						],
					},
				}),
			},
		]);
		const clamped = derivePluginNavigation(plugins, () => true).settingsPanels[0]?.value.name;
		expect(clamped).toBe(label);
		expect([...(clamped ?? '')]).toHaveLength(32);
		expect(clamped).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
	});

	it('strips control characters from a plugin-authored label before rendering', () => {
		// Build the control character programmatically so no raw byte lands in source.
		const noisy = `Bad${String.fromCharCode(7)}Name`;
		const plugins = composeBundledPlugins([
			{
				packageName: '@acme/noisy',
				manifest: definePlugin({
					id: 'noisy',
					version: '1.0.0',
					capabilities: ['ui:settings'],
					flag: { default: false },
					contributes: {
						settingsPanels: [
							{ id: 'x', name: noisy, href: '/dashboard/admin/noisy', icon: 'lucide:x' },
						],
					},
				}),
			},
		]);
		expect(derivePluginNavigation(plugins, () => true).settingsPanels[0]?.value.name).toBe(
			'BadName'
		);
	});

	it('strips bidi-override and zero-width format characters from a label', () => {
		// U+202E (RLO, a bidi override) and U+200B (zero-width space), built
		// programmatically so no invisible byte lands in source.
		const spoof = `Sett${String.fromCharCode(0x202e)}i${String.fromCharCode(0x200b)}ngs`;
		const plugins = composeBundledPlugins([
			{
				packageName: '@acme/spoof',
				manifest: definePlugin({
					id: 'spoof',
					version: '1.0.0',
					capabilities: ['ui:settings'],
					flag: { default: false },
					contributes: {
						settingsPanels: [
							{ id: 'x', name: spoof, href: '/dashboard/admin/spoof', icon: 'lucide:x' },
						],
					},
				}),
			},
		]);
		expect(derivePluginNavigation(plugins, () => true).settingsPanels[0]?.value.name).toBe(
			'Settings'
		);
	});

	it('returns empty contributions when no plugins contribute navigation', () => {
		expect(derivePluginNavigation([], () => true)).toEqual({ navItems: [], settingsPanels: [] });
	});
});

describe('registry seam', () => {
	it('routes core sections through the host merge (core-first, deterministic)', () => {
		const merged = mergeHostedNavigation({
			core: [
				{ id: 'a', enabled: true, value: 'a' },
				{ id: 'b', enabled: false, value: 'b' },
			],
		});
		expect(merged).toEqual(['a']);
	});
});
