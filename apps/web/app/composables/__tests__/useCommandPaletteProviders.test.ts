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
import type { PaletteItem } from '~/lib/commandPalette';
import { createTestI18n } from '~/__tests__/i18n';

const { t } = createTestI18n().global;

let role: 'owner' | 'admin' | 'editor' | null;
let disabledFlags: string[];
let openCompose: ReturnType<typeof vi.fn>;
let openNewContact: ReturnType<typeof vi.fn>;
let navigations: unknown[];

const SIDEBAR_SECTIONS = [
	{
		name: 'shared.dashboardNavigation.sections.administration',
		items: [
			{
				name: 'shared.dashboardNavigation.items.administration.overview',
				href: '/dashboard/admin',
				icon: 'lucide:gauge',
			},
		],
	},
];

beforeEach(() => {
	role = 'admin';
	disabledFlags = [];
	openCompose = vi.fn(async () => {});
	openNewContact = vi.fn(async () => {});
	navigations = [];

	vi.stubGlobal('useI18n', () => ({ t }));
	vi.stubGlobal('useFeatureFlag', () => ({
		isEnabled: (flag: string) => !disabledFlags.includes(flag),
	}));
	vi.stubGlobal('useDesktopContext', () => ({ isDesktop: ref(false) }));
	vi.stubGlobal('useDashboardNavigation', () => ({ navigationSections: ref(SIDEBAR_SECTIONS) }));
	vi.stubGlobal('usePermissions', () => ({ role: ref(role) }));
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
});

describe('navigation', () => {
	it('reaches the admin leaves the sidebar hides behind a hub', async () => {
		const { navItems } = await providers();
		const labels = navItems.value.map((item) => item.label);

		// The ramp controls are the deepest of them: four clicks through a hub and
		// a collapsed disclosure, and previously no keyboard route at all.
		expect(labels).toEqual(expect.arrayContaining(['AI provider', 'Webhooks', 'Controls']));
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
		expect(admin[0]?.icon).toBe('lucide:gauge');
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
