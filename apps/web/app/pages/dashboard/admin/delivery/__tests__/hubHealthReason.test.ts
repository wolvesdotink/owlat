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
import { i18nStubs } from '~/__tests__/i18n';
import {
	NO_PROVIDER_DE,
	NO_PROVIDER_HEALTH,
	germanTestI18n,
	healthQueryStub,
} from '~/__tests__/deliveryHealthFixture';
import { useDeliveryHealth } from '~/composables/useDeliveryHealth';

const SENDING_OVERVIEW = { warming: null, volume: null, reputation: null, abuseStatus: 'clean' };

beforeEach(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('useHead', vi.fn());
	vi.stubGlobal('definePageMeta', vi.fn());
	vi.stubGlobal('navigateTo', vi.fn());
	vi.stubGlobal('useOrganizationContext', () => ({ isLoading: ref(false) }));
	vi.stubGlobal('useDeliveryHealth', useDeliveryHealth);
	vi.stubGlobal(
		'useOrganizationQuery',
		healthQueryStub(NO_PROVIDER_HEALTH, (name) => {
			if (name === getFunctionName(api.analytics.reputationQueries.getSendingOverview)) {
				return SENDING_OVERVIEW;
			}
			if (name === getFunctionName(api.delivery.postmaster.getPostmasterStatus)) {
				return { connected: false, domains: [] };
			}
			return name === getFunctionName(api.blockedEmails.blocklist.getCountsByReason) ? null : [];
		})
	);
});

describe('the delivery hub header', () => {
	it('words the roll-up reason in German', () => {
		const wrapper = mount(DeliveryHubPage, {
			global: {
				stubs: {
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
					NuxtLink: { template: '<a><slot /></a>' },
				},
				components: { UiQueryBoundary: QueryBoundary },
				plugins: [germanTestI18n()],
			},
		});

		expect(wrapper.text()).toContain(NO_PROVIDER_DE);
		expect(wrapper.text()).not.toContain('No delivery provider');
	});
});
