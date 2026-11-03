/**
 * Collapsed to the icon rail, each inbox is a swatch and its initials. The
 * entry still has to say which inbox has new mail and which one is open, or
 * the rail cannot be scanned for "where is new mail".
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import ConversationsNav from '../ConversationsNav.vue';

let route: { path: string; query: Record<string, unknown> };
let activeMailboxId: ReturnType<typeof ref<string | null>>;

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
	Object.assign(globalThis, {
		useI18n: i18nStubs.useI18n,
		useRoute: () => route,
		useFeatureFlag: () => ({ isEnabled: () => false }),
		usePermissions: () => ({ isAdmin: ref(false), isRoleLoading: ref(false) }),
		useInboxes: () => ({ inboxes: ref(inboxes), hasPersonalMail: ref(true) }),
		usePostboxActiveMailbox: () => ({ activeMailboxId }),
		useAnswerQueueCount: () => ({ count: ref(0) }),
		useShellSidebarPrefs: () => ({
			perInbox: ref(5),
			sort: ref('recent'),
			isCollapsed: () => false,
			toggleGroup: () => undefined,
		}),
	});
});

function mountRail() {
	return mount(ConversationsNav, {
		props: { collapsed: true, extraItems: [] },
		global: {
			plugins: [createTestI18n()],
			components: { NuxtLink: NuxtLinkStub },
			stubs: {
				UiTooltip: { template: '<div><slot /></div>' },
				InboxChip: true,
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
