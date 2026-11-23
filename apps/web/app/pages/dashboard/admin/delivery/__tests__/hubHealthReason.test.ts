/**
 * The delivery hub's header prints the health roll-up's reason under the title
 * when sending is not healthy. The backend names the reason by code, so a
 * German reader gets the German sentence, not the backend's English.
 */
import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { api } from '@owlat/api';
import { getFunctionName } from 'convex/server';
import DeliveryHubPage from '../index.vue';
import QueryBoundary from '~/components/ui/QueryBoundary.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import {
	NO_PROVIDER_DE,
	NO_PROVIDER_HEALTH,
	germanTestI18n,
	healthQueryStub,
} from '~/__tests__/deliveryHealthFixture';
import { useDeliveryHealth } from '~/composables/useDeliveryHealth';

const SENDING_OVERVIEW = { warming: null, volume: null, reputation: null, abuseStatus: 'clean' };

const SUSPENSION_REASON =
	'Auto-suspended: Gmail reports a spam rate of 0.42% for mail.example.com on 2026-11-19';
const SUSPENDED_OVERVIEW = {
	...SENDING_OVERVIEW,
	abuseStatus: 'suspended',
	abuseStatusReason: SUSPENSION_REASON,
	abuseStatusChangedAt: Date.UTC(2026, 10, 20, 9, 0, 0),
};

/** Answer the hub's reads with `overview` as the sending overview. */
function stubHubQueries(overview: object) {
	vi.stubGlobal(
		'useOrganizationQuery',
		healthQueryStub(NO_PROVIDER_HEALTH, (name) => {
			if (name === getFunctionName(api.analytics.reputationQueries.getSendingOverview)) {
				return overview;
			}
			if (name === getFunctionName(api.delivery.postmaster.getPostmasterStatus)) {
				return { connected: false, domains: [] };
			}
			return name === getFunctionName(api.blockedEmails.blocklist.getCountsByReason) ? null : [];
		})
	);
}

/** `isPlatformAdmin`, the one non-organization read on the hub. */
function stubPlatformAdmin(isAdmin: boolean) {
	vi.stubGlobal('useConvexQuery', () => ({ data: ref(isAdmin), error: ref(null) }));
}

const HUB_STUBS = {
	UiIconBox: true,
	UiSpinner: true,
	UiStatTile: true,
	UiTrendChart: true,
	UiSkeleton: true,
	UiEmptyState: true,
	DeliveryMeasurementCoverageCard: true,
	DeliveryReadinessPanel: true,
	DeliveryTransportCard: true,
	DeliveryComplianceTelemetryCard: true,
	DeliverySendingDetails: true,
	DeliveryPostmasterComplianceCard: true,
	DeliveryDomainTable: true,
	UiCard: { template: '<div><slot /></div>' },
	UiButton: { template: '<button><slot /></button>' },
	NuxtLink: { props: ['to'], template: '<a :data-to="to"><slot /></a>' },
};

beforeEach(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('useHead', vi.fn());
	vi.stubGlobal('definePageMeta', vi.fn());
	vi.stubGlobal('navigateTo', vi.fn());
	vi.stubGlobal('useOrganizationContext', () => ({ isLoading: ref(false) }));
	vi.stubGlobal('useDeliveryHealth', useDeliveryHealth);
	stubHubQueries(SENDING_OVERVIEW);
	stubPlatformAdmin(false);
});

describe('the delivery hub header', () => {
	it('words the roll-up reason in German', () => {
		const wrapper = mount(DeliveryHubPage, {
			global: {
				stubs: HUB_STUBS,
				components: { UiQueryBoundary: QueryBoundary },
				plugins: [germanTestI18n()],
			},
		});

		expect(wrapper.text()).toContain(NO_PROVIDER_DE);
		expect(wrapper.text()).not.toContain('No delivery provider');
	});
});

describe('the delivery hub suspension banner', () => {
	function mountHub() {
		return mount(DeliveryHubPage, {
			global: {
				stubs: HUB_STUBS,
				components: { UiQueryBoundary: QueryBoundary },
				plugins: [createTestI18n()],
			},
		});
	}

	it('quotes the stored reason and links a platform admin to the operator console', () => {
		stubHubQueries(SUSPENDED_OVERVIEW);
		stubPlatformAdmin(true);
		const wrapper = mountHub();

		expect(wrapper.find('blockquote').text()).toBe(SUSPENSION_REASON);
		expect(wrapper.text()).toContain('Since ');
		expect(wrapper.find('a[data-to="/dashboard/admin/operator"]').exists()).toBe(true);
		expect(wrapper.text()).not.toMatch(/contact support/i);
	});

	it('tells a member who cannot lift it who can, without the link', () => {
		stubHubQueries(SUSPENDED_OVERVIEW);
		stubPlatformAdmin(false);
		const wrapper = mountHub();

		expect(wrapper.find('blockquote').text()).toBe(SUSPENSION_REASON);
		expect(wrapper.find('a[data-to="/dashboard/admin/operator"]').exists()).toBe(false);
		expect(wrapper.text()).toContain('A platform admin of this instance can lift it');
	});
});
