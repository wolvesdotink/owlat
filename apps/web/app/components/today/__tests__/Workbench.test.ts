/**
 * The Workbench's own pieces, mounted against the real `en` catalog:
 *   - the tab row is an ARIA tablist; ←/→ select the neighbour, and a tab
 *     says what waits there (answers first, else unread);
 *   - "Filed away" shows one tile per kind with its count and a few senders,
 *     each opening that exact list in this inbox, and nothing for empty kinds;
 *   - the scope header names the inbox and jumps to its bands;
 *   - with no inbox, the empty state offers a way to add one only where that
 *     page opens; with mail switched off it says so, and links an admin to
 *     Features;
 *   - none of them has axe violations.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { inject, provide, ref } from 'vue';
import type { FeatureFlagKey } from '@owlat/shared/featureFlags';
import { mount } from '@vue/test-utils';
import TodayWorkbenchTabs from '../TodayWorkbenchTabs.vue';
import TodayFiledAway from '../TodayFiledAway.vue';
import TodayScopeHeader from '../TodayScopeHeader.vue';
import TodayNoInbox from '../TodayNoInbox.vue';
import { auditA11y } from '~/__tests__/a11y';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import type { WorkbenchTab } from '~/utils/workbench';
import { FILED_CATEGORIES } from '@owlat/shared/threadStatus';
import { MAIL_CATEGORY_META } from '~/utils/mailCategory';
import { MegaphoneIcon } from '@coolicons/vue';

// The empty state's flags and role; each test sets its own.
const enabledFlags = new Set<FeatureFlagKey>();
const isAdmin = ref(true);

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
	vi.stubGlobal('useFeatureFlag', () => ({
		isEnabled: (flag: FeatureFlagKey) => enabledFlags.has(flag),
	}));
	vi.stubGlobal('usePermissions', () => ({ isAdmin }));
	// The real UiDropdownMenu (audited below) uses these two Nuxt auto-imports.
	vi.stubGlobal('provide', provide);
	vi.stubGlobal('inject', inject);
});

const TABS: WorkbenchTab[] = [
	{
		scope: 'mb_me',
		name: 'Marcel',
		slot: 0,
		address: 'marcel@owlat.example',
		isTeam: false,
		answer: 2,
		unread: 6,
	},
	{
		scope: 'mb_support',
		name: 'Support',
		slot: 1,
		address: 'support@owlat.example',
		isTeam: false,
		answer: 0,
		unread: 11,
	},
	{
		scope: 'team',
		name: 'Team inbox',
		slot: null,
		address: null,
		isTeam: true,
		answer: 0,
		unread: 0,
	},
];

const stubs = { NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' } };

describe('TodayWorkbenchTabs', () => {
	it('marks the open tab and says what waits in each', () => {
		const w = mount(TodayWorkbenchTabs, {
			props: { tabs: TABS, selected: 'mb_me' },
			global: { plugins: [createTestI18n()], stubs },
		});
		const tabs = w.findAll('[role="tab"]');
		expect(tabs.map((tab) => tab.attributes('aria-selected'))).toEqual(['true', 'false', 'false']);
		expect(tabs[0]!.attributes('tabindex')).toBe('0');
		expect(tabs[0]!.find('[aria-label]').attributes('aria-label')).toBe('2 need an answer');
		expect(tabs[1]!.find('[aria-label]').attributes('aria-label')).toBe('11 unread');
	});

	it('selects the neighbour with the arrow keys and clicks', async () => {
		const w = mount(TodayWorkbenchTabs, {
			props: { tabs: TABS, selected: 'mb_support' },
			global: { plugins: [createTestI18n()], stubs },
		});
		const list = w.find('[role="tablist"]');
		await list.trigger('keydown', { key: 'ArrowRight' });
		await list.trigger('keydown', { key: 'Home' });
		await w.findAll('[role="tab"]')[2]!.trigger('click');
		expect(w.emitted('select')).toEqual([['team'], ['mb_me'], ['team']]);
	});

	it('has no axe violations', async () => {
		const violations = await auditA11y(TodayWorkbenchTabs, {
			props: { tabs: TABS, selected: 'mb_me' },
			global: { plugins: [createTestI18n()] },
		});
		expect(violations).toEqual([]);
	});
});

const MODEL = {
	filed: { newsletter: 12, notification: 2, receipt: 0, promotion: 0, spam: 1 },
	filedSenders: {
		newsletter: ['The Verge', 'Stratechery', 'Platformer'],
		notification: ['GitHub', 'Linear'],
		receipt: [],
		promotion: [],
		spam: [],
	},
	filedTotal: 15,
};

describe('TodayFiledAway', () => {
	it('counts each kind, names a few senders and links to that list', () => {
		const w = mount(TodayFiledAway, {
			props: { model: MODEL, scope: 'mb_me' },
			global: { plugins: [createTestI18n()], stubs },
		});
		const tiles = w.findAll('[data-filed-kind]');
		expect(tiles.map((tile) => tile.attributes('data-filed-kind'))).toEqual([
			'newsletter',
			'notification',
			'spam',
		]);
		expect(tiles[0]!.text()).toContain('12');
		expect(tiles[0]!.text()).toContain('newsletters');
		expect(tiles[0]!.text()).toContain('From The Verge, Stratechery, Platformer and others');
		expect(tiles[1]!.text()).toContain('From GitHub, Linear');
		expect(tiles[1]!.text()).not.toContain('and others');
		expect(tiles[0]!.attributes('href')).toBe(
			'/dashboard/postbox/all-inboxes?in=mb_me&category=newsletter'
		);
	});

	it('gives each kind the icon the inbox and bundles use for it', () => {
		const w = mount(TodayFiledAway, {
			props: {
				model: {
					...MODEL,
					filed: { newsletter: 1, notification: 1, receipt: 1, promotion: 1, spam: 1 },
					filedTotal: 5,
				},
				scope: 'mb_me',
			},
			global: { plugins: [createTestI18n()], stubs },
		});
		const row = (kind: string) => w.find(`[data-filed-kind="${kind}"]`);
		for (const kind of FILED_CATEGORIES) {
			expect(row(kind).findComponent(MAIL_CATEGORY_META[kind].icon).exists()).toBe(true);
		}
		// The tag is the Recategorize button; a promotion wears the megaphone.
		expect(row('promotion').findComponent(MegaphoneIcon).exists()).toBe(true);
	});

	it('says so when nothing was filed away', () => {
		const w = mount(TodayFiledAway, {
			props: {
				model: {
					...MODEL,
					filed: { newsletter: 0, notification: 0, receipt: 0, promotion: 0, spam: 0 },
					filedTotal: 0,
				},
				scope: 'mb_me',
			},
			global: { plugins: [createTestI18n()], stubs },
		});
		expect(w.text()).toContain('Nothing filed away since you last looked.');
	});

	it('has no axe violations', async () => {
		const violations = await auditA11y(TodayFiledAway, {
			props: { model: MODEL, scope: 'mb_me' },
			global: { plugins: [createTestI18n()] },
		});
		expect(violations).toEqual([]);
	});
});

describe('TodayScopeHeader', () => {
	// A controlled ⋯ menu, like the real one: it opens only through `open`.
	const headerStubs = {
		...stubs,
		UiButton: { template: '<button><slot /></button>' },
		UiSkeleton: true,
		UiDropdownMenu: {
			props: ['open'],
			emits: ['update:open'],
			template:
				'<div><span data-trigger @click="$emit(\'update:open\', !open)"><slot name="trigger" /></span><div v-if="open" role="menu"><slot /></div></div>',
		},
		UiDropdownMenuItem: { template: '<button role="menuitem"><slot /></button>' },
	};
	const props = {
		name: 'Support',
		slot: 1,
		address: 'support@owlat.example',
		kind: 'shared' as const,
		sinceLabel: 'Since you last looked (4:11 PM): 23 new emails.',
		isLoading: false,
		stats: { newMail: 23, isNewMailCapped: false, important: 3, moved: 2, filed: 15 },
		canMarkSeen: true,
		inboxHref: '/dashboard/postbox/inbox?mailbox=mb_support',
		composeHref: '/compose?mailbox=mb_support',
	};

	it('names the inbox and jumps from each number to its band', () => {
		const w = mount(TodayScopeHeader, {
			props,
			global: {
				plugins: [createTestI18n()],
				stubs: headerStubs,
			},
		});
		expect(w.find('h2').text()).toBe('Support');
		expect(w.text()).toContain('Shared inbox');
		const stats = w.findAll('[data-scope-stat]');
		expect(stats.map((s) => [s.attributes('data-scope-stat'), s.attributes('href')])).toEqual([
			['new', '#workbench-updates'],
			['important', '#workbench-updates'],
			['moved', '#workbench-changed'],
			['filed', '#workbench-filed'],
		]);
		expect(stats[0]!.text()).toBe('23 new emails');
	});

	it('leaves zeros out, and says so when nothing is new', () => {
		const mountWith = (stats: typeof props.stats) =>
			mount(TodayScopeHeader, {
				props: { ...props, stats },
				global: { plugins: [createTestI18n()], stubs: headerStubs },
			});
		const some = mountWith({
			newMail: 4,
			isNewMailCapped: false,
			important: 0,
			moved: 0,
			filed: 1,
		});
		expect(some.findAll('[data-scope-stat]').map((s) => s.attributes('data-scope-stat'))).toEqual([
			'new',
			'filed',
		]);
		const none = mountWith({
			newMail: 0,
			isNewMailCapped: false,
			important: 0,
			moved: 0,
			filed: 0,
		});
		expect(none.findAll('[data-scope-stat]')).toHaveLength(0);
		expect(none.text()).toContain('nothing new');
	});

	it('keeps "Open inbox" and "Write" one click away in its menu', async () => {
		const w = mount(TodayScopeHeader, {
			props,
			global: { plugins: [createTestI18n()], stubs: headerStubs },
		});
		expect(w.find('[role="menu"]').exists()).toBe(false);
		await w.find('[data-trigger]').trigger('click');
		expect(w.findAll('[role="menuitem"]').map((item) => item.text())).toEqual([
			'Open inbox',
			'Write',
		]);
	});

	it('leaves "new email" and "moved" out on the team inbox', () => {
		const w = mount(TodayScopeHeader, {
			props: {
				...props,
				kind: 'team',
				address: null,
				stats: { ...props.stats, newMail: null, moved: null },
			},
			global: {
				plugins: [createTestI18n()],
				stubs: headerStubs,
			},
		});
		expect(w.findAll('[data-scope-stat]').map((s) => s.attributes('data-scope-stat'))).toEqual([
			'important',
			'filed',
		]);
	});

	it.each([
		['closed', false],
		['open', true],
	])('has no axe violations with its real ⋯ menu %s', async (_state, open) => {
		const violations = await auditA11y(TodayScopeHeader, {
			props,
			global: { plugins: [createTestI18n()] },
			prepare: async (wrapper) => {
				if (!open) return;
				await wrapper.get('button[aria-label="More for Support"]').trigger('click');
				expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(2);
			},
		});
		expect(violations).toEqual([]);
	});
});

describe('TodayNoInbox', () => {
	const noInboxStubs = {
		UiButton: { props: ['to'], template: '<a :href="to"><slot /></a>' },
	};
	function mountEmpty(opts: { mail: FeatureFlagKey | null; admin: boolean }) {
		enabledFlags.clear();
		if (opts.mail) enabledFlags.add(opts.mail);
		isAdmin.value = opts.admin;
		return mount(TodayNoInbox, {
			global: { plugins: [createTestI18n()], stubs: noInboxStubs },
		});
	}
	const hrefs = (w: ReturnType<typeof mountEmpty>) =>
		w.findAll('a').map((a) => a.attributes('href'));

	it.each([
		['an admin', 'postbox', true],
		['a member', 'mail.external', false],
	] as const)('offers to connect a mailbox to %s while %s is on', (_who, flag, admin) => {
		const w = mountEmpty({ mail: flag, admin });
		expect(w.find('h2').text()).toBe('No inbox to work from yet');
		expect(hrefs(w)).toEqual(['/dashboard/preferences/add-account']);
		expect(w.text()).toContain('Connect a mailbox');
	});

	it('says mail is off and links an admin to Features, not to a page that bounces', () => {
		const w = mountEmpty({ mail: null, admin: true });
		expect(w.find('h2').text()).toBe('Mail is turned off in this workspace');
		expect(w.text()).toContain('Features');
		expect(hrefs(w)).toEqual(['/dashboard/admin/instance/features']);
		expect(w.text()).toContain('Open Features');
	});

	it('tells a member mail is off, with no link', () => {
		const w = mountEmpty({ mail: null, admin: false });
		expect(w.find('h2').text()).toBe('Mail is turned off in this workspace');
		expect(w.text()).toContain('An admin can turn it on.');
		expect(hrefs(w)).toEqual([]);
	});

	it.each([
		['mail on', true],
		['mail off', false],
	])('has no axe violations with %s', async (_state, mail) => {
		enabledFlags.clear();
		if (mail) enabledFlags.add('postbox');
		isAdmin.value = true;
		const violations = await auditA11y(TodayNoInbox, {
			global: { plugins: [createTestI18n()], stubs: { NuxtLink: stubs.NuxtLink } },
		});
		expect(violations).toEqual([]);
	});
});
