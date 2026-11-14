/**
 * The marketing sidebar's delivery line prints the health roll-up's reason, and
 * its tooltip carries it in full. The backend names the reason by code, so a
 * German reader gets the German sentence, not the backend's English.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref } from 'vue';
import { i18nStubs } from '~/__tests__/i18n';
import {
	NO_PROVIDER_DE,
	NO_PROVIDER_HEALTH,
	germanTestI18n,
	healthQueryStub,
} from '~/__tests__/deliveryHealthFixture';
import { useDeliveryHealth } from '~/composables/useDeliveryHealth';
import MarketingNav from '../MarketingNav.vue';

const NuxtLinkStub = {
	props: ['to'],
	template: '<a :href="to"><slot /></a>',
};

const TooltipStub = {
	props: ['text'],
	template: '<div :data-tooltip="text"><slot /></div>',
};

let health: unknown;

beforeEach(() => {
	health = NO_PROVIDER_HEALTH;
	Object.assign(globalThis, {
		useI18n: i18nStubs.useI18n,
		useRoute: () => ({ path: '/dashboard/campaigns' }),
		useFeatureFlag: () => ({ isEnabled: () => true }),
		usePermissions: () => ({ isAdmin: ref(true), isRoleLoading: ref(false), can: () => true }),
		useConvexQuery: () => ({ data: ref(undefined) }),
		useOrganizationQuery: (query: never) => healthQueryStub(health)(query),
		useDeliveryHealth,
		formatCompactRelativeTime: () => '',
		useShellSidebarPrefs: () => ({
			perInbox: ref(5),
			sort: ref('recent'),
			isCollapsed: () => false,
			toggleGroup: () => undefined,
		}),
	});
});

function mountNav() {
	return mount(MarketingNav, {
		props: { collapsed: false, extraItems: [] },
		global: {
			plugins: [germanTestI18n()],
			components: { NuxtLink: NuxtLinkStub },
			stubs: {
				UiSkeleton: true,
				UiTooltip: TooltipStub,
				ShellSidebarOptions: true,
				ShellThreadRow: true,
			},
		},
	});
}

describe('Marketing sidebar delivery line', () => {
	it('prints the roll-up reason in German, in the line and its tooltip', () => {
		const wrapper = mountNav();
		const line = wrapper.find('a[href="/dashboard/admin/delivery"]');
		expect(line.text()).toBe(NO_PROVIDER_DE);
		expect(wrapper.find(`[data-tooltip="${NO_PROVIDER_DE}"]`).exists()).toBe(true);
		expect(wrapper.text()).not.toContain('No delivery provider');
	});

	it('falls back to its own line for a reason this build cannot word', () => {
		health = { level: 'error', reasonCode: 'a_newer_reason' };
		const wrapper = mountNav();
		const line = wrapper.find('a[href="/dashboard/admin/delivery"]');
		expect(line.text()).not.toBe('');
		expect(line.text()).not.toContain('a_newer_reason');
	});
});
