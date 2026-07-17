import { describe, expect, it } from 'vitest';
import { composeBundledPlugins, mergeHostedNavigation } from '@owlat/plugin-host';
import { definePlugin, parsePluginId } from '@owlat/plugin-kit';
import type { FeatureFlagKey } from '@owlat/shared/featureFlags';
import {
	buildNavigationSections,
	derivePluginNavigation,
	type NavigationSection,
	type PluginNavigationContributions,
} from '../dashboardNavigation';

/**
 * Conformance suite for the navigation/settings registry conversion.
 *
 * The core of this file is a verbatim copy of the pre-conversion hand-rolled
 * builder (`referenceSections`). PP-15 requires that converting the sidebar and
 * settings entries into host-mediated contributions changes NOTHING about core
 * membership, order or gating, so we assert the new registry-based builder
 * equals the reference for EVERY combination of the flags that influence it, in
 * both desktop and web contexts. If a future change alters a core destination,
 * this exhaustive pin fails with the exact flag combination.
 */

const FLAGS = [
	'inbox',
	'inbox.codeTasks',
	'postbox',
	'mail.external',
	'chat',
	'ai.assistant',
	'campaigns',
	'automations',
	'transactional',
	'ai.knowledge',
	'ai.knowledge.analytics',
	'ai.agent',
	'ai.autonomy',
] as const satisfies readonly FeatureFlagKey[];

function referenceSections(on: ReadonlySet<string>, isDesktop: boolean): NavigationSection[] {
	const f = (key: string) => on.has(key);

	const settingsItems = [
		{ name: 'Overview', href: '/dashboard/settings', icon: 'lucide:settings' },
		{ name: 'Workspace', href: '/dashboard/settings/workspace', icon: 'lucide:building-2' },
		{ name: 'Properties', href: '/dashboard/settings/properties', icon: 'lucide:tags' },
		{ name: 'Features', href: '/dashboard/settings/features', icon: 'lucide:toggle-right' },
		...(f('ai.agent')
			? [
					{ name: 'AI Agent', href: '/dashboard/settings/agent', icon: 'lucide:bot' },
					{
						name: 'Agent Health',
						href: '/dashboard/settings/agent-health',
						icon: 'lucide:activity',
					},
				]
			: []),
		...(f('ai.autonomy')
			? [
					{
						name: 'Autonomy',
						href: '/dashboard/settings/autonomy',
						icon: 'lucide:sliders-horizontal',
					},
				]
			: []),
		{ name: 'Messaging', href: '/dashboard/settings/channels', icon: 'lucide:radio' },
		...(f('postbox') || f('mail.external')
			? [{ name: 'Team Inboxes', href: '/dashboard/settings/team-inboxes', icon: 'lucide:mails' }]
			: []),
		{ name: 'Account', href: '/dashboard/settings/account', icon: 'lucide:users' },
		...(isDesktop ? [{ name: 'Desktop', href: '/desktop/settings', icon: 'lucide:monitor' }] : []),
	];

	const inboxItems = [
		{ name: 'All Threads', href: '/dashboard/inbox', icon: 'lucide:message-square' },
		{ name: 'All activity', href: '/dashboard/inbox/activity', icon: 'lucide:activity' },
		{ name: 'Review Queue', href: '/dashboard/inbox/review', icon: 'lucide:check-circle' },
		...(f('inbox.codeTasks')
			? [{ name: 'Code Tasks', href: '/dashboard/inbox/code-tasks', icon: 'lucide:code' }]
			: []),
		{ name: 'Quarantine', href: '/dashboard/inbox/quarantine', icon: 'lucide:shield-alert' },
	];

	const sendItems = [
		...(f('campaigns')
			? [{ name: 'Campaigns', href: '/dashboard/campaigns', icon: 'lucide:megaphone' }]
			: []),
		...(f('automations')
			? [{ name: 'Automations', href: '/dashboard/automations', icon: 'lucide:zap' }]
			: []),
		...(f('transactional')
			? [{ name: 'Transactional', href: '/dashboard/send/transactional', icon: 'lucide:file-code' }]
			: []),
		{ name: 'Templates & blocks', href: '/dashboard/send', icon: 'lucide:layout-grid' },
	];

	const sections: NavigationSection[] = [];

	if (f('inbox')) {
		sections.push({ key: 'inbox', name: 'Team Inbox', icon: 'lucide:inbox', items: inboxItems });
	}
	if (f('postbox') || f('mail.external')) {
		sections.push({
			key: 'postbox',
			name: 'Postbox',
			icon: 'lucide:mailbox',
			href: '/dashboard/postbox',
			items: [
				{ name: 'Inbox', href: '/dashboard/postbox/inbox', icon: 'lucide:inbox' },
				{ name: 'Sent', href: '/dashboard/postbox/sent', icon: 'lucide:send' },
				{ name: 'Drafts', href: '/dashboard/postbox/drafts', icon: 'lucide:file-edit' },
				{ name: 'Spam', href: '/dashboard/postbox/spam', icon: 'lucide:shield-alert' },
				{ name: 'Trash', href: '/dashboard/postbox/trash', icon: 'lucide:trash' },
				{ name: 'Settings', href: '/dashboard/postbox/settings', icon: 'lucide:settings' },
			],
		});
	}
	if (f('chat')) {
		sections.push({
			key: 'chat',
			name: 'Chat',
			icon: 'lucide:message-circle',
			href: '/dashboard/chat',
			items: [{ name: 'Messages', href: '/dashboard/chat', icon: 'lucide:message-circle' }],
		});
	}
	if (f('ai.assistant')) {
		sections.push({
			key: 'assistant',
			name: 'Assistant',
			icon: 'lucide:sparkles',
			href: '/dashboard/assistant',
			items: [{ name: 'Chat', href: '/dashboard/assistant', icon: 'lucide:sparkles' }],
		});
	}
	sections.push({ key: 'send', name: 'Send', icon: 'lucide:send', items: sendItems });
	sections.push({
		key: 'audience',
		name: 'Audience',
		icon: 'lucide:users',
		items: [
			{ name: 'Overview', href: '/dashboard/audience', icon: 'lucide:layout-dashboard' },
			{ name: 'Contacts', href: '/dashboard/audience/contacts', icon: 'lucide:users' },
			{ name: 'Topics', href: '/dashboard/audience/topics', icon: 'lucide:list-filter' },
			{ name: 'Segments', href: '/dashboard/audience/segments', icon: 'lucide:user-plus' },
			{ name: 'Suppressions', href: '/dashboard/audience/suppressions', icon: 'lucide:ban' },
		],
	});
	sections.push({
		key: 'delivery',
		name: 'Delivery',
		icon: 'lucide:truck',
		items: [
			{ name: 'Health', href: '/dashboard/delivery', icon: 'lucide:activity' },
			{ name: 'Setup', href: '/dashboard/delivery/setup', icon: 'lucide:settings-2' },
		],
	});
	if (f('ai.knowledge')) {
		sections.push({
			key: 'knowledge',
			name: 'Knowledge',
			icon: 'lucide:brain',
			items: [
				{ name: 'Explorer', href: '/dashboard/knowledge', icon: 'lucide:brain' },
				...(f('ai.knowledge.analytics')
					? [{ name: 'Graph', href: '/dashboard/knowledge/graph', icon: 'lucide:share-2' }]
					: []),
			],
		});
	}
	sections.push({
		key: 'settings',
		name: 'Settings',
		icon: 'lucide:settings',
		items: settingsItems,
	});

	return sections;
}

function envFor(mask: number, isDesktop: boolean) {
	const on = new Set<string>();
	FLAGS.forEach((flagKey, index) => {
		if (mask & (1 << index)) on.add(flagKey);
	});
	return { on, isFeatureEnabled: (flag: FeatureFlagKey) => on.has(flag), isDesktop };
}

describe('buildNavigationSections — core conformance', () => {
	it('matches the pre-conversion builder for every flag combination (desktop and web)', () => {
		const total = 1 << FLAGS.length;
		for (let mask = 0; mask < total; mask += 1) {
			for (const isDesktop of [false, true]) {
				const { on, isFeatureEnabled } = envFor(mask, isDesktop);
				const actual = buildNavigationSections({ isFeatureEnabled, isDesktop });
				const expected = referenceSections(on, isDesktop);
				expect(actual, `mask=${mask} desktop=${isDesktop}`).toEqual(expected);
			}
		}
	});

	it('registers the full core section order when every flag is on', () => {
		const { isFeatureEnabled } = envFor((1 << FLAGS.length) - 1, true);
		const sections = buildNavigationSections({ isFeatureEnabled, isDesktop: true });
		expect(sections.map((s) => s.key)).toEqual([
			'inbox',
			'postbox',
			'chat',
			'assistant',
			'send',
			'audience',
			'delivery',
			'knowledge',
			'settings',
		]);
	});

	it('keeps the always-on sections when every flag is off', () => {
		const sections = buildNavigationSections({ isFeatureEnabled: () => false, isDesktop: false });
		expect(sections.map((s) => s.key)).toEqual(['send', 'audience', 'delivery', 'settings']);
		expect(sections.find((s) => s.key === 'send')?.items.map((i) => i.href)).toEqual([
			'/dashboard/send',
		]);
	});
});

const alwaysOn = { isFeatureEnabled: () => true, isDesktop: false };

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

	it('drops a plugin item whose target section is feature-off', () => {
		const env = { isFeatureEnabled: (f: FeatureFlagKey) => f !== 'ai.knowledge', isDesktop: false };
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
		expect(contacts?.name).toBe('Contacts');
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
						id: '/dashboard/settings/deals',
						order: 0,
						enabled: true,
						value: {
							name: 'Deals sync',
							href: '/dashboard/settings/deals',
							icon: 'lucide:refresh-ccw',
						},
					},
				],
			})
		);
		expect(sections.find((s) => s.key === 'settings')?.items.at(-1)?.href).toBe(
			'/dashboard/settings/deals'
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
								href: '/dashboard/settings/deals',
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
								name: 'BadName ',
								href: '/dashboard/settings/rogue',
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
							{ id: 'x', name: noisy, href: '/dashboard/settings/noisy', icon: 'lucide:x' },
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
							{ id: 'x', name: spoof, href: '/dashboard/settings/spoof', icon: 'lucide:x' },
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
