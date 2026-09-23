// @vitest-environment happy-dom
/**
 * Knowledge and the Assistant are for every member while their features are
 * on. Onboarding promises both to everyone and the routes are member-level,
 * but the only ways in used to be admin-only: the Assistant in the user menu
 * and Knowledge inside the Settings sidebar. These pin the member's view.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import SidebarFooter from '../SidebarFooter.vue';
import ConversationsNav from '../ConversationsNav.vue';

let flags: Set<string>;
let path: string;

const NuxtLinkStub = {
	props: ['to'],
	template: '<a :href="to"><slot /></a>',
};

beforeEach(() => {
	flags = new Set(['ai.assistant', 'ai.knowledge']);
	path = '/dashboard';
	Object.assign(globalThis, {
		useI18n: i18nStubs.useI18n,
		useRoute: () => ({ path }),
		useFeatureFlag: () => ({ isEnabled: (flag: string) => flags.has(flag) }),
		// A member: every admin-only branch is closed.
		usePermissions: () => ({ isAdmin: ref(false) }),
		useAuth: () => ({
			user: ref({ name: 'Ada Member', email: 'ada@example.com' }),
			signOut: vi.fn(),
			isPending: ref(false),
		}),
		useKeyboardShortcuts: () => ({ openHelpModal: vi.fn() }),
		useInboxes: () => ({ inboxes: ref([]), hasPersonalMail: ref(false) }),
		useAnswerQueue: () => ({ count: ref(0) }),
		useShellSidebarPrefs: () => ({
			perInbox: ref(5),
			sort: ref('recent'),
			isCollapsed: () => false,
			toggleGroup: vi.fn(),
		}),
	});
});

const global = {
	plugins: [createTestI18n()],
	components: { NuxtLink: NuxtLinkStub },
	stubs: {
		Icon: true,
		UiSkeleton: true,
		UiThemeToggle: true,
		ShellSidebarOptions: true,
		ShellInboxGroup: true,
		ShellTeamInboxGroup: true,
		ShellChatGroup: true,
		InboxChip: true,
	},
};

describe('the Assistant in the user menu', () => {
	it('is offered to a member while the feature is on', async () => {
		const wrapper = mount(SidebarFooter, { props: { collapsed: false }, global });
		await wrapper.get('button[aria-haspopup="menu"]').trigger('click');
		expect(wrapper.find('a[href="/dashboard/assistant"]').exists()).toBe(true);
	});

	it('is not offered while the feature is off', async () => {
		flags.delete('ai.assistant');
		const wrapper = mount(SidebarFooter, { props: { collapsed: false }, global });
		await wrapper.get('button[aria-haspopup="menu"]').trigger('click');
		expect(wrapper.find('a[href="/dashboard/assistant"]').exists()).toBe(false);
	});
});

describe('Knowledge in the Conversations sidebar', () => {
	it('is listed for a member while the feature is on', () => {
		const wrapper = mount(ConversationsNav, {
			props: { collapsed: false, extraItems: [] },
			global,
		});
		const link = wrapper.get('[data-testid="shell-nav-knowledge"]');
		expect(link.attributes('href')).toBe('/dashboard/knowledge');
		expect(link.text()).toBe('Knowledge');
	});

	it('marks itself current anywhere under Knowledge', () => {
		path = '/dashboard/knowledge/graph';
		const wrapper = mount(ConversationsNav, {
			props: { collapsed: true, extraItems: [] },
			global,
		});
		expect(wrapper.get('[data-testid="shell-nav-knowledge"]').attributes('aria-current')).toBe(
			'page'
		);
	});

	it('is not listed while the feature is off', () => {
		flags.delete('ai.knowledge');
		const wrapper = mount(ConversationsNav, {
			props: { collapsed: false, extraItems: [] },
			global,
		});
		expect(wrapper.find('[data-testid="shell-nav-knowledge"]').exists()).toBe(false);
	});
});
