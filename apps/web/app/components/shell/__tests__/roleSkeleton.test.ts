// @vitest-environment happy-dom
/**
 * Pages render before the member role is known (only the `admin` guard waits
 * for it), so the sidebar's admin-only parts hold their place with a skeleton
 * while the role loads instead of popping in afterwards.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import ConversationsNav from '../ConversationsNav.vue';
import MarketingNav from '../MarketingNav.vue';

let flags: Set<string>;
let isAdmin: ReturnType<typeof ref<boolean>>;
let isRoleLoading: ReturnType<typeof ref<boolean>>;

const NuxtLinkStub = {
	props: ['to'],
	template: '<a :href="to"><slot /></a>',
};

beforeEach(() => {
	flags = new Set(['inbox', 'chat', 'campaigns', 'automations']);
	isAdmin = ref(false);
	isRoleLoading = ref(true);
	Object.assign(globalThis, {
		useI18n: i18nStubs.useI18n,
		useRoute: () => ({ path: '/dashboard' }),
		useFeatureFlag: () => ({ isEnabled: (flag: string) => flags.has(flag) }),
		usePermissions: () => ({ isAdmin, isRoleLoading }),
		useInboxes: () => ({ inboxes: ref([]), hasPersonalMail: ref(true) }),
		useAnswerQueue: () => ({ count: ref(0) }),
		useShellSidebarPrefs: () => ({
			perInbox: ref(5),
			sort: ref('recent'),
			isCollapsed: () => false,
			toggleGroup: () => undefined,
		}),
		useConvexQuery: () => ({ data: ref(undefined) }),
		useDeliveryHealth: () => ({ level: ref(null), reason: ref(null) }),
		formatCompactRelativeTime: () => '',
	});
});

const global = {
	plugins: [createTestI18n()],
	components: { NuxtLink: NuxtLinkStub },
	stubs: {
		Icon: true,
		UiSkeleton: true,
		ShellSidebarOptions: true,
		ShellInboxGroup: true,
		ShellTeamInboxGroup: true,
		ShellChatGroup: true,
		ShellThreadRow: true,
		InboxChip: true,
	},
};

const props = { collapsed: false, extraItems: [] };

describe('Conversations sidebar while the role loads', () => {
	it('holds the team inbox and chat place with a skeleton', () => {
		const wrapper = mount(ConversationsNav, { props, global });
		expect(wrapper.find('[data-testid="shell-nav-role-skeleton"]').exists()).toBe(true);
	});

	it('swaps the skeleton for the admin groups once the role says admin', async () => {
		const wrapper = mount(ConversationsNav, { props, global });
		isAdmin.value = true;
		isRoleLoading.value = false;
		await wrapper.vm.$nextTick();
		expect(wrapper.find('[data-testid="shell-nav-role-skeleton"]').exists()).toBe(false);
		expect(wrapper.findComponent({ name: 'ShellTeamInboxGroup' }).exists()).toBe(true);
	});

	it('shows no skeleton when neither admin feature is on', () => {
		flags = new Set();
		const wrapper = mount(ConversationsNav, { props, global });
		expect(wrapper.find('[data-testid="shell-nav-role-skeleton"]').exists()).toBe(false);
	});
});

describe('Marketing sidebar while the role loads', () => {
	it('holds the Automations and Templates place with a skeleton', () => {
		const wrapper = mount(MarketingNav, { props, global });
		expect(wrapper.find('[data-testid="shell-marketing-role-skeleton"]').exists()).toBe(true);
		expect(wrapper.find('a[href="/dashboard/send"]').exists()).toBe(false);
	});

	it('drops the skeleton once the role is known', async () => {
		const wrapper = mount(MarketingNav, { props, global });
		isAdmin.value = true;
		isRoleLoading.value = false;
		await wrapper.vm.$nextTick();
		expect(wrapper.find('[data-testid="shell-marketing-role-skeleton"]').exists()).toBe(false);
		expect(wrapper.find('a[href="/dashboard/send"]').exists()).toBe(true);
	});
});
