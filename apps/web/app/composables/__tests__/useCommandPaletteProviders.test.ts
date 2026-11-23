/**
 * The palette's static providers: what ⌘K can DO and where it can GO.
 *
 * Two promises are pinned here, because both were broken and neither broke a
 * test:
 *   - a "Create" verb creates. "Compose" ran a navigation to the inbox list and
 *     "New contact" one to the contacts list, so the palette moved you and left
 *     you to find the button yourself.
 *   - navigation reaches the whole app. The sidebar lists ~40 destinations; the
 *     admin leaves behind their hubs (AI provider, webhooks, ramp controls) were
 *     not offered at all, and their gating has to survive being read out of a
 *     table that carries no gates of its own.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref } from 'vue';
import { api } from '@owlat/api';
import { getFunctionName, type FunctionReference } from 'convex/server';
import type { PaletteItem } from '~/lib/commandPalette';
import { createTestI18n } from '~/__tests__/i18n';
import { GaugeIcon } from '@coolicons/vue';
import { ALL_FEATURE_FLAG_KEYS, getDefaultFlags, resolveFlags } from '@owlat/shared/featureFlags';
import { buildNavigationSections } from '~/lib/dashboardNavigation';
import { ROUTE_FEATURE_RULES, blockedFeature } from '~/lib/routeFeatureGates';

const { t } = createTestI18n().global;

const showChecklist = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('~/composables/useGettingStartedControls', () => ({
	useGettingStartedControls: () => ({ showChecklist }),
}));

let role: 'owner' | 'admin' | 'editor' | null;
let hasRampStarted: boolean;
let disabledFlags: string[];
let openCompose: ReturnType<typeof vi.fn>;
let openNewContact: ReturnType<typeof vi.fn>;
let navigations: unknown[];
let latestSignInCode: unknown;
let showToast: ReturnType<typeof vi.fn>;
let action: ReturnType<typeof vi.fn>;

const SIDEBAR_SECTIONS = [
	{
		name: 'shared.dashboardNavigation.sections.administration',
		items: [
			{
				name: 'shared.dashboardNavigation.items.administration.overview',
				href: '/dashboard/admin',
				icon: GaugeIcon,
			},
		],
	},
];

beforeEach(() => {
	role = 'admin';
	hasRampStarted = true;
	disabledFlags = [];
	openCompose = vi.fn(async () => {});
	openNewContact = vi.fn(async () => {});
	navigations = [];
	latestSignInCode = null;
	showToast = vi.fn();
	showChecklist.mockClear();
	vi.stubGlobal('useToast', () => ({ showToast }));
	action = vi.fn(async () => ({ status: 'checking' }));
	// A backend that only schedules the worker call answers success either way.
	vi.stubGlobal('useConvex', () => ({ action, mutation: vi.fn(async () => ({ accounts: 1 })) }));

	vi.stubGlobal('useI18n', () => ({ t }));
	vi.stubGlobal('useFeatureFlag', () => ({
		isEnabled: (flag: string) => !disabledFlags.includes(flag),
	}));
	vi.stubGlobal('useDesktopContext', () => ({ isDesktop: ref(false) }));
	vi.stubGlobal('useDashboardNavigation', () => ({ navigationSections: ref(SIDEBAR_SECTIONS) }));
	vi.stubGlobal('usePermissions', () => ({ role: ref(role) }));
	// The admin registry's reads: a platform admin, and the ramp as the test sets it.
	vi.stubGlobal('useConvexQuery', (query: FunctionReference<'query'>, args: () => unknown) => {
		if (args() === 'skip') return { data: ref(undefined) };
		const name = getFunctionName(query);
		if (name === getFunctionName(api.delivery.rampControlQueries.hasRampStarted)) {
			return { data: ref(hasRampStarted) };
		}
		if (name === getFunctionName(api.platformAdmin.platformAdmin.isPlatformAdmin)) {
			return { data: ref(true) };
		}
		if (name === getFunctionName(api.mail.signInCodes.latestSignInCode)) {
			return { data: ref(latestSignInCode) };
		}
		return { data: ref(undefined) };
	});
	vi.stubGlobal('useQuickCreate', () => ({ openCompose, openNewContact }));
	vi.stubGlobal('useSidebarContext', () => ({
		showToggle: ref(false),
		activeContext: ref('inbox'),
		switchContext: () => {},
	}));
	vi.stubGlobal('navigateTo', (to: unknown) => {
		navigations.push(to);
		return Promise.resolve();
	});
});

async function providers() {
	vi.resetModules();
	const { useCommandPaletteProviders } = await import('../useCommandPaletteProviders');
	return useCommandPaletteProviders();
}

function byId(items: PaletteItem[], id: string): PaletteItem | undefined {
	return items.find((item) => item.id === id);
}

describe('verbs', () => {
	it('composes instead of navigating to the inbox list', async () => {
		const { verbItems } = await providers();

		byId(verbItems.value, 'verb:compose')?.run();

		expect(openCompose).toHaveBeenCalledTimes(1);
		expect(navigations).toEqual([]);
	});

	it('opens the Add contact dialog instead of the contacts list', async () => {
		const { verbItems } = await providers();

		byId(verbItems.value, 'verb:new-contact')?.run();

		expect(openNewContact).toHaveBeenCalledTimes(1);
		expect(navigations).toEqual([]);
	});

	it('brings back the setup checklist, for every role', async () => {
		role = 'editor';
		const { actionItems } = await providers();

		const verb = byId(actionItems.value, 'verb:show-setup-checklist');
		expect(verb?.label).toBe('Show setup checklist');
		verb?.run();

		expect(showChecklist).toHaveBeenCalledTimes(1);
	});

	it('copies the latest live sign-in code, naming its sender domain', async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		vi.stubGlobal('navigator', { clipboard: { writeText } });
		latestSignInCode = {
			kind: 'code',
			value: '482913',
			senderDomain: 'northwind.example',
			expiresAt: Date.now() + 60_000,
		};
		const { actionItems } = await providers();

		const verb = byId(actionItems.value, 'verb:copy-sign-in-code');
		expect(verb?.label).toBe('Copy latest sign-in code');
		expect(verb?.subtitle).toBe('482913 · northwind.example');
		verb?.run();

		await vi.waitFor(() => expect(showToast).toHaveBeenCalledWith('Code copied'));
		expect(writeText).toHaveBeenCalledWith('482913');
	});

	it('opens the latest sign-in link instead of copying it', async () => {
		const open = vi.spyOn(window, 'open').mockReturnValue(null);
		latestSignInCode = {
			kind: 'link',
			value: 'https://app.fabrikam.example/login/magic?token=1',
			senderDomain: 'fabrikam.example',
			expiresAt: Date.now() + 60_000,
		};
		const { actionItems } = await providers();

		const verb = byId(actionItems.value, 'verb:copy-sign-in-code');
		expect(verb?.label).toBe('Open latest sign-in link');
		verb?.run();

		expect(open).toHaveBeenCalledWith(
			'https://app.fabrikam.example/login/magic?token=1',
			'_blank',
			'noopener,noreferrer'
		);
		open.mockRestore();
	});

	it('offers no sign-in code verb without a live code or without personal mail', async () => {
		expect(byId((await providers()).actionItems.value, 'verb:copy-sign-in-code')).toBeUndefined();

		latestSignInCode = {
			kind: 'code',
			value: '482913',
			senderDomain: 'northwind.example',
			expiresAt: Date.now() + 60_000,
		};
		disabledFlags = ['postbox', 'mail.external'];
		expect(byId((await providers()).actionItems.value, 'verb:copy-sign-in-code')).toBeUndefined();
	});

	it('checks the connected accounts for mail and says so', async () => {
		const { actionItems } = await providers();

		const verb = byId(actionItems.value, 'verb:check-mail');
		expect(verb?.label).toBe('Check for mail');
		verb?.run();
		await vi.waitFor(() => expect(showToast).toHaveBeenCalled());

		expect(getFunctionName(action.mock.calls[0]![0])).toBe(
			getFunctionName(api.mail.external.checkForMail.request)
		);
		expect(showToast).toHaveBeenCalledWith(
			'Checking your connected accounts for new mail.',
			'info'
		);
	});

	it('says the mail check failed when mail-sync did not take it', async () => {
		action = vi.fn(async () => ({ status: 'failed' }));
		const { actionItems } = await providers();

		byId(actionItems.value, 'verb:check-mail')?.run();
		await vi.waitFor(() => expect(showToast).toHaveBeenCalled());

		expect(showToast).toHaveBeenCalledWith(
			"Couldn't check for new mail. Try again in a moment.",
			'error'
		);
	});

	it('offers no mail check without personal mail', async () => {
		disabledFlags = ['postbox', 'mail.external'];
		const { actionItems } = await providers();

		expect(byId(actionItems.value, 'verb:check-mail')).toBeUndefined();
	});

	it('drops Compose entirely when no mail feature is on', async () => {
		disabledFlags = ['postbox', 'mail.external'];
		const { verbItems } = await providers();

		expect(byId(verbItems.value, 'verb:compose')).toBeUndefined();
	});

	it('offers only what the quick-create registry lets this member create', async () => {
		// The registry gates a contact behind `canManageContacts` (admin), because
		// the Add dialog the verb deep-links to is. Offering it to an editor was a
		// keystroke that navigated and then did nothing.
		role = 'editor';
		const { verbItems } = await providers();

		expect(byId(verbItems.value, 'verb:new-contact')).toBeUndefined();
		expect(byId(verbItems.value, 'verb:new-automation')).toBeUndefined();
		// Campaigns are editor work, so that one survives.
		expect(byId(verbItems.value, 'verb:new-campaign')).toBeDefined();
	});

	it('picks up a registry verb the palette never listed on its own', async () => {
		const { verbItems } = await providers();

		byId(verbItems.value, 'verb:new-automation')?.run();

		expect(navigations).toEqual(['/dashboard/automations/new']);
	});
	// "Create" lists what creates something; the rest are actions under their
	// own heading, so the Create cap can never cut "Check for mail".
	it('keeps the verbs that create nothing out of Create', async () => {
		latestSignInCode = { kind: 'code', value: '123456', senderDomain: 'owlat.app' };
		const { verbItems, actionItems } = await providers();

		expect(verbItems.value.map((item) => item.id)).toEqual([
			'verb:compose',
			'verb:new-campaign',
			'verb:draft-campaign-ai',
			'verb:new-contact',
			'verb:new-automation',
			'verb:new-transactional',
		]);
		expect(actionItems.value.map((item) => item.id)).toEqual([
			'verb:copy-sign-in-code',
			'verb:check-mail',
			'verb:ask-knowledge',
			'verb:zen',
			'verb:show-setup-checklist',
		]);
	});
});

describe('navigation', () => {
	it('reaches the admin leaves the sidebar hides behind a hub', async () => {
		const { navItems } = await providers();
		const labels = navItems.value.map((item) => item.label);

		// The ramp controls are the deepest of them: four clicks through a hub and
		// a collapsed disclosure, and previously no keyboard route at all.
		expect(labels).toEqual(
			expect.arrayContaining(['AI provider', 'Webhooks', 'Delivery controls'])
		);
	});

	it('leaves the ramp pages out until the ramp has started', async () => {
		hasRampStarted = false;
		const { navItems } = await providers();
		const ramp = navItems.value.filter((item) =>
			item.id.startsWith('nav:/dashboard/admin/delivery/advanced')
		);

		expect(ramp).toEqual([]);
		// The rest of Email delivery is still one keystroke away.
		expect(byId(navItems.value, 'nav:/dashboard/admin/delivery/webhooks')).toBeDefined();
	});

	it('navigates to the route it names', async () => {
		const { navItems } = await providers();

		byId(navItems.value, 'nav:/dashboard/admin/delivery/webhooks')?.run();

		expect(navigations).toEqual(['/dashboard/admin/delivery/webhooks']);
	});

	it('lists a route the sidebar already carries exactly once, with the sidebar wording', async () => {
		const { navItems } = await providers();
		const admin = navItems.value.filter((item) => item.id === 'nav:/dashboard/admin');

		expect(admin).toHaveLength(1);
		expect(admin[0]?.icon).toBe(GaugeIcon);
	});

	it('lists the settings hub under its registry name, found by "settings" and "preferences"', async () => {
		const { SETTINGS_REGISTRY } = await import('~/lib/settingsRegistry');
		const hub = SETTINGS_REGISTRY.find((entry) => entry.path === '/dashboard/preferences')!;
		vi.stubGlobal('useDashboardNavigation', () => ({
			navigationSections: ref([
				{
					name: 'shared.breadcrumbRoutes.sections.preferences',
					items: [{ name: hub.titleKey, href: hub.path, icon: hub.icon }],
				},
			]),
		}));
		const { navItems } = await providers();

		const row = byId(navItems.value, 'nav:/dashboard/preferences') as
			| (PaletteItem & { keywords?: readonly string[] })
			| undefined;
		expect(row?.label).toBe('General');
		expect(row?.subtitle).toBe('My settings');
		expect(row?.keywords).toEqual(expect.arrayContaining(['settings', 'preferences']));
	});

	it('offers a member nothing under /dashboard/admin', async () => {
		role = 'editor';
		const { navItems } = await providers();
		const adminRoutes = navItems.value.filter(
			(item) => item.id.startsWith('nav:/dashboard/admin/') // the hub itself comes from the sidebar stub
		);

		expect(adminRoutes).toEqual([]);
	});
});

describe('one row per destination', () => {
	it('gives every destination its route, so the palette can show it once', async () => {
		const { verbItems, navItems } = await providers();

		expect(byId(verbItems.value, 'verb:new-campaign')?.href).toBe('/dashboard/campaigns/new');
		// Overlay verbs have no route to collide on.
		expect(byId(verbItems.value, 'verb:compose')?.href).toBeUndefined();
		for (const item of navItems.value)
			expect(item.href, item.id).toBe(item.id.slice('nav:'.length));
	});

	it('shows "New campaign" once for "camp", under Create', async () => {
		const { mergeGroups, filterItems } = await import('~/lib/commandPalette');
		const { verbItems, navItems } = await providers();

		const merged = mergeGroups([
			{ key: 'navigation', heading: '', order: 40, items: filterItems(navItems.value, 'camp') },
			{ key: 'verbs', heading: '', order: 5, items: filterItems(verbItems.value, 'camp') },
		]);
		const rows = merged.flatMap((group) =>
			group.items.map((item) => ({ group: group.key, label: item.label, href: item.href }))
		);
		const newCampaign = rows.filter((row) => row.href === '/dashboard/campaigns/new');
		expect(newCampaign).toEqual([
			{ group: 'verbs', label: 'New campaign', href: '/dashboard/campaigns/new' },
		]);
	});

	it('files Campaigns under Marketing', async () => {
		const { navItems } = await providers();
		expect(byId(navItems.value, 'nav:/dashboard/campaigns')?.subtitle).toBe('Marketing');
	});
});

describe('settings controls', () => {
	const adminControls = (items: PaletteItem[]) =>
		items.filter((item) => item.id.startsWith('setting:admin:')).map((item) => item.id);

	it('indexes the Workspace controls for an admin, beside the personal ones', async () => {
		const { settingsItems } = await providers();
		expect(adminControls(settingsItems.value)).toEqual([
			'setting:admin:domains:dkim',
			'setting:admin:aiProvider:aiProviderKey',
			'setting:admin:aiReplies:autonomy',
			'setting:admin:rampControls:rampPace',
			'setting:admin:deliverability:alertChannels',
			'setting:admin:webhooks:webhookSecret',
			'setting:admin:brandKit:brandColors',
			'setting:admin:features:operatingMode',
			'setting:admin:instanceGeneral:transactionalSender',
			'setting:admin:apiKeys:transactionalSendLimits',
		]);
		expect(byId(settingsItems.value, 'setting:overview:appearance')).toBeDefined();
	});

	it('offers a member none of them', async () => {
		role = 'editor';
		const { settingsItems } = await providers();
		expect(adminControls(settingsItems.value)).toEqual([]);
		expect(byId(settingsItems.value, 'setting:overview:appearance')).toBeDefined();
	});

	it('follows the page gates: no ramp pace before the ramp has started', async () => {
		hasRampStarted = false;
		const { settingsItems } = await providers();
		expect(adminControls(settingsItems.value)).not.toContain('setting:admin:rampControls:rampPace');
	});

	it('names the control, files it under its page, and deep-links to its anchor', async () => {
		const { settingsItems } = await providers();
		const dkim = byId(settingsItems.value, 'setting:admin:domains:dkim');
		expect(dkim?.label).toBe('DKIM signing');
		expect(dkim?.subtitle).toBe('Sending domains');
		dkim?.run();
		expect(navigations).toEqual(['/dashboard/admin/delivery/domains#sending-domain-list']);
	});
});

/**
 * Every row the composable builds, run for real: none may navigate to a page
 * the feature middleware would bounce. The sidebar is the real table here, so
 * its rows are gated as they are in the app.
 */
describe('rows and switched-off features', () => {
	const defaults = resolveFlags(getDefaultFlags());
	const gated = [
		...new Set(
			ROUTE_FEATURE_RULES.flatMap((rule) => [
				...(rule.required === undefined ? [] : [rule.required].flat()),
				...(rule.anyOf ?? []),
			])
		),
	];
	const CASES: ReadonlyArray<readonly [string, string[]]> = [
		['the defaults', ALL_FEATURE_FLAG_KEYS.filter((flag) => !defaults[flag])],
		['every flag off', [...ALL_FEATURE_FLAG_KEYS]],
		...gated.map((flag) => [`only ${flag} off`, [flag]] as const),
	];

	it.each(CASES)('navigates only to pages that open with %s', async (_name, off) => {
		disabledFlags = off;
		role = 'owner';
		vi.stubGlobal('useDashboardNavigation', () => ({
			navigationSections: ref(
				buildNavigationSections({
					isFeatureEnabled: (flag) => !disabledFlags.includes(flag),
					isDesktop: false,
					role,
				})
			),
		}));
		const rows = await providers();
		for (const item of [
			...rows.verbItems.value,
			...rows.actionItems.value,
			...rows.contextItems.value,
			...rows.navItems.value,
			...rows.settingsItems.value,
		]) {
			await item.run();
		}

		expect(navigations.length).toBeGreaterThan(0);
		const isEnabled = (flag: string) => !disabledFlags.includes(flag);
		const bounced = navigations
			.map((to) => (typeof to === 'string' ? to : (to as { path: string }).path))
			.filter((href) => blockedFeature(href, isEnabled) !== null);
		expect(bounced).toEqual([]);
	});
});
