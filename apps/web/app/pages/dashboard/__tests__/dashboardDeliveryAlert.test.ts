/**
 * The dashboard's delivery alert prints the health roll-up's reason for an
 * admin when sending is broken. The backend names the reason by code, so a
 * German reader gets the German sentence, not the backend's English.
 *
 * The no-inbox empty state waits for the live feature flags: until they
 * answer (a slow first read times out and answers later), the mail flags read
 * as off and the inbox list is not read, so the page would claim mail is off
 * in a workspace that has it.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref } from 'vue';
import {
	dashboardShellStubs,
	installNuxtStubs,
	paginatedResult,
	queryResult,
} from '~/__tests__/a11y';
import { i18nStubs } from '~/__tests__/i18n';
import {
	NO_PROVIDER_DE,
	NO_PROVIDER_HEALTH,
	germanTestI18n,
	healthQueryStub,
} from '~/__tests__/deliveryHealthFixture';
import { useDeliveryHealth } from '~/composables/useDeliveryHealth';
import { useFeatureOffNotice } from '~/composables/useFeatureOffNotice';
import DashboardHome from '../index.vue';

const flagsLoading = ref(false);
const flagsError = ref<Error | null>(null);

const NuxtLinkStub = { props: ['to'], template: '<a :href="to"><slot /></a>' };

/** The page's feature cards; each has its own suite. */
const FEATURE_STUBS = Object.fromEntries(
	[
		'DashboardAccessRequests',
		'DashboardGettingStarted',
		'DashboardMailboxRequests',
		'TodayAnswerCard',
		'TodayChanges',
		'TodayFiledAway',
		'TodayInboxPicker',
		'TodayNoInbox',
		'TodayPeekPanel',
		'TodayScopeHeader',
		'TodayToDo',
		'TodayUpcoming',
		'TodayUpdates',
		'TodayWorkbenchTabs',
		'TodayZenMore',
		'UiButton',
		'UiPageHeader',
		'UiQueryBoundary',
		'UiSkeleton',
	].map((name) => [name, true])
);

beforeEach(() => {
	installNuxtStubs({
		...i18nStubs,
		useRoute: () => ({ path: '/dashboard', fullPath: '/dashboard', query: {}, params: {} }),
		...dashboardShellStubs(),
		usePermissions: () => ({
			isAdmin: ref(true),
			isRoleLoading: ref(false),
			can: () => true,
		}),
		useFeatureFlag: () => ({
			flags: ref({}),
			isEnabled: () => false,
			isLoading: flagsLoading,
			error: flagsError,
		}),
		useDeliveryHealth,
		useFeatureOffNotice,
		useOrganizationQuery: healthQueryStub(NO_PROVIDER_HEALTH),
		useConvexQuery: () => queryResult(undefined),
		usePaginatedQuery: () => paginatedResult([]),
	});
});

describe('dashboard delivery alert', () => {
	it('words the roll-up reason in German', () => {
		const wrapper = mount(DashboardHome, {
			global: { plugins: [germanTestI18n()], stubs: { ...FEATURE_STUBS, NuxtLink: NuxtLinkStub } },
		});

		const alert = wrapper.find('a[href="/dashboard/admin/delivery"]');
		expect(alert.text()).toContain(NO_PROVIDER_DE);
		expect(alert.text()).not.toContain('No delivery provider');
	});
});

describe('dashboard with no inbox', () => {
	function mountHome() {
		return mount(DashboardHome, {
			global: { plugins: [germanTestI18n()], stubs: { ...FEATURE_STUBS, NuxtLink: NuxtLinkStub } },
		});
	}

	it('shows the empty state only once the flags have answered', () => {
		flagsLoading.value = true;
		try {
			const pending = mountHome();
			expect(pending.find('today-no-inbox-stub').exists()).toBe(false);
			expect(pending.find('ui-skeleton-stub').exists()).toBe(true);
		} finally {
			flagsLoading.value = false;
		}
		expect(mountHome().find('today-no-inbox-stub').exists()).toBe(true);
	});

	it('keeps waiting when the first flags read timed out', () => {
		flagsError.value = new Error('Convex query subscription timed out');
		try {
			const timedOut = mountHome();
			expect(timedOut.find('today-no-inbox-stub').exists()).toBe(false);
			expect(timedOut.find('ui-skeleton-stub').exists()).toBe(true);
		} finally {
			flagsError.value = null;
		}
	});
});
