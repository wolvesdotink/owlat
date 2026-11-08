/**
 * Collapsed to the icon rail, each inbox is a swatch and its mark or initials.
 * The entry still has to say which inbox has new mail and which one is open,
 * or the rail cannot be scanned for "where is new mail", and two inboxes must
 * never look the same.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import ConversationsNav from '../ConversationsNav.vue';
import InboxChip from '../../inbox/InboxChip.vue';
import { resolveInboxIdentities, type AccessibleInboxRow } from '~/utils/inboxIdentity';

// The inbox drop targets are their own test (railMailboxDrop.test.ts).
vi.mock('~/composables/postbox/usePostboxMessageDrag', () => ({
	usePostboxMailboxDropTargets: () => ({ isOver: () => false, mailbox: () => ({}) }),
}));

let route: { path: string; query: Record<string, unknown> };
let activeMailboxId: ReturnType<typeof ref<string | null>>;
let railInboxes: ReturnType<typeof ref<unknown[]>>;

const inboxes = [
	{
		mailboxId: 'mb_dev',
		name: 'Dev',
		address: 'dev@owlat.dev',
		scope: 'personal',
		slot: 0,
		unread: 0,
	},
	{
		mailboxId: 'mb_team',
		name: 'Team',
		address: 'team@owlat.dev',
		scope: 'shared',
		slot: 1,
		unread: 3,
	},
	{
		mailboxId: 'mb_sales',
		name: 'Sales',
		address: 'sales@owlat.dev',
		scope: 'shared',
		slot: 2,
		unread: 140,
	},
];

const NuxtLinkStub = {
	props: ['to'],
	template: '<a :href="to"><slot /></a>',
};

beforeEach(() => {
	route = { path: '/dashboard', query: {} };
	activeMailboxId = ref(null);
	railInboxes = ref<unknown[]>(inboxes);
	Object.assign(globalThis, {
		useI18n: i18nStubs.useI18n,
		useRoute: () => route,
		useFeatureFlag: () => ({ isEnabled: () => false }),
		usePermissions: () => ({ isAdmin: ref(false), isRoleLoading: ref(false) }),
		useInboxes: () => ({ inboxes: railInboxes, hasPersonalMail: ref(true) }),
		usePostboxActiveMailbox: () => ({ activeMailboxId }),
		useAnswerQueueCount: () => ({ count: ref(0) }),
		useTaskOpenCount: () => ({ count: ref(0) }),
		useShellSidebarPrefs: () => ({
			perInbox: ref(5),
			sort: ref('recent'),
			isCollapsed: () => false,
			toggleGroup: () => undefined,
		}),
	});
});

function mountRail({ realChip = false } = {}) {
	return mount(ConversationsNav, {
		props: { collapsed: true, extraItems: [] },
		global: {
			plugins: [createTestI18n()],
			components: { NuxtLink: NuxtLinkStub, InboxChip },
			stubs: {
				UiTooltip: { template: '<div><slot /></div>' },
				...(realChip ? {} : { InboxChip: true }),
				ShellSidebarOptions: true,
				ShellInboxGroup: true,
				ShellTeamInboxGroup: true,
				ShellChatGroup: true,
				UiSkeleton: true,
			},
		},
	});
}

const entry = (wrapper: ReturnType<typeof mountRail>, id: string) =>
	wrapper.find(`a[href="/dashboard/postbox/inbox?mailbox=${id}"]`);

describe('Collapsed rail inbox entries', () => {
	it('shows the unread count on an inbox with new mail, and none on an empty one', () => {
		const wrapper = mountRail();
		expect(entry(wrapper, 'mb_team').find('[data-testid="rail-inbox-unread"]').text()).toBe('3');
		expect(entry(wrapper, 'mb_dev').find('[data-testid="rail-inbox-unread"]').exists()).toBe(false);
	});

	it('caps the count at 99+', () => {
		const wrapper = mountRail();
		expect(entry(wrapper, 'mb_sales').find('[data-testid="rail-inbox-unread"]').text()).toBe('99+');
	});

	it('names the unread count in the accessible label', () => {
		const wrapper = mountRail();
		expect(entry(wrapper, 'mb_team').attributes('aria-label')).toBe('Team, 3 unread');
		expect(entry(wrapper, 'mb_dev').attributes('aria-label')).toBe('Dev');
	});

	it('marks the inbox named in the Postbox URL as current', () => {
		route = { path: '/dashboard/postbox/inbox', query: { mailbox: 'mb_team' } };
		const wrapper = mountRail();
		expect(entry(wrapper, 'mb_team').attributes('aria-current')).toBe('page');
		expect(entry(wrapper, 'mb_dev').attributes('aria-current')).toBeUndefined();
	});

	it('falls back to the selected mailbox inside the Postbox when the URL names none', () => {
		route = { path: '/dashboard/postbox/inbox/msg_1', query: {} };
		activeMailboxId.value = 'mb_sales';
		const wrapper = mountRail();
		expect(entry(wrapper, 'mb_sales').attributes('aria-current')).toBe('page');
	});

	it('marks no inbox outside the Postbox', () => {
		activeMailboxId.value = 'mb_team';
		const wrapper = mountRail();
		for (const inbox of inboxes) {
			expect(entry(wrapper, inbox.mailboxId).attributes('aria-current')).toBeUndefined();
		}
	});
});

function accessibleRow(
	mailboxId: string,
	label: string,
	extra: Partial<AccessibleInboxRow> = {}
): AccessibleInboxRow {
	return {
		mailboxId,
		label,
		address: `${mailboxId}@owlat.dev`,
		scope: 'shared',
		colorSlot: null,
		unread: 0,
		...extra,
	};
}

describe('Collapsed rail inbox marks', () => {
	it('tells inboxes that share their first letters apart', () => {
		railInboxes.value = resolveInboxIdentities([
			accessibleRow('mb_work', 'Work'),
			accessibleRow('mb_wolves', 'Wolves'),
			accessibleRow('mb_webshop', 'Webshop'),
		]);
		const wrapper = mountRail({ realChip: true });
		expect(entry(wrapper, 'mb_work').text()).toBe('Wor');
		expect(entry(wrapper, 'mb_wolves').text()).toBe('Wol');
		expect(entry(wrapper, 'mb_webshop').text()).toBe('We');
	});

	it('shows the icon or emoji the owner picked instead of initials', () => {
		railInboxes.value = resolveInboxIdentities([
			accessibleRow('mb_work', 'Work', { mark: 'work' }),
			accessibleRow('mb_wolves', 'Wolves', { mark: '🐺' }),
		]);
		const wrapper = mountRail({ realChip: true });
		const work = entry(wrapper, 'mb_work');
		expect(work.find('[data-mark="icon:work"]').exists()).toBe(true);
		expect(work.text()).toBe('');
		const wolves = entry(wrapper, 'mb_wolves');
		expect(wolves.find('[data-mark="emoji"]').text()).toBe('🐺');
		expect(wolves.attributes('aria-label')).toBe('Wolves');
	});

	it('falls back to the provider logo of a connected account, and to initials without one', () => {
		railInboxes.value = resolveInboxIdentities([
			accessibleRow('mb_gmail', 'Private', { provider: 'gmail', isConnected: true }),
			accessibleRow('mb_ms', 'Office', { provider: 'microsoft', isConnected: true }),
			accessibleRow('mb_picked', 'Shop', { provider: 'gmail', mark: 'shop' }),
			accessibleRow('mb_plain', 'Team'),
		]);
		const wrapper = mountRail({ realChip: true });
		expect(entry(wrapper, 'mb_gmail').find('[data-mark="provider:gmail"]').exists()).toBe(true);
		expect(entry(wrapper, 'mb_ms').find('[data-mark="provider:microsoft"]').exists()).toBe(true);
		const picked = entry(wrapper, 'mb_picked');
		expect(picked.find('[data-mark="icon:shop"]').exists()).toBe(true);
		expect(picked.find('[data-mark^="provider"]').exists()).toBe(false);
		const plain = entry(wrapper, 'mb_plain');
		expect(plain.find('[data-mark]').exists()).toBe(false);
		expect(plain.text()).toBe('T');
	});
});
