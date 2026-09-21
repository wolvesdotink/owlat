// @vitest-environment happy-dom
/**
 * THE TRANSPORT PAGE'S THREE PENDING STATES (UX plan item 55 / admin-delivery-06).
 *
 * This page used to have two honest states and one dead end. First load was a
 * bare centred `lucide:loader-2` in a `py-16` box — the whole page blanked and
 * then reflowed when the query landed — while its sibling delivery lists stood
 * in for their rows with a content-shaped skeleton. And the content branch was
 * a `v-else-if="status"` with NO `v-else`, so a `getStatus` that resolved to
 * nothing painted the header and then a blank page: not "no provider
 * configured", not an error, just nothing.
 *
 * All three now run through the shared `UiQueryBoundary`, which is what makes
 * them exhaustive by construction. What is worth pinning is that each branch
 * says the true thing:
 *   - in flight → a placeholder shaped like the cards that are coming;
 *   - resolved with nothing → a named terminal state with a way forward;
 *   - resolved with a status → the real cards, and no skeleton left behind.
 */
import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { getFunctionName, type FunctionReference } from 'convex/server';
import { api } from '@owlat/api';
import TransportPage from '../transport.vue';
import QueryBoundary from '~/components/ui/QueryBoundary.vue';
// The can-send verdict (and the paste-ready remedy under it) is a real child
// component; stubbing it would hide the very sentence these branches are about.
import DeliveryTransportCanSendCard from '~/components/delivery/TransportCanSendCard.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import en from '~~/i18n/locales/en.json';

/** The shape `getStatus` answers with on a configured deployment. */
function transportStatus() {
	return {
		provider: 'ses',
		isKnownProvider: true,
		canSend: true,
		outboundTlsMode: 'opportunistic',
		requiredEnv: [{ name: 'AWS_ACCESS_KEY_ID', isPresent: true }],
		lastTestSucceededAt: null,
	};
}

interface QueryState {
	status: unknown;
	isLoading: boolean;
	error: Error | null;
}

function stubPage({ status, isLoading, error }: QueryState): void {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('useHead', vi.fn());
	vi.stubGlobal('definePageMeta', vi.fn());
	vi.stubGlobal('useCopyToClipboard', () => ({ copy: vi.fn(), isCopied: () => false }));
	vi.stubGlobal('useRuntimeConfig', () => ({
		public: { convexSiteUrl: 'https://example.convex.site', convexUrl: '' },
	}));
	const statusQuery = getFunctionName(api.delivery.status.getStatus);
	vi.stubGlobal('useOrganizationQuery', (query: FunctionReference<'query'>) => {
		if (getFunctionName(query) === statusQuery) {
			return {
				data: ref(status),
				isLoading: ref(isLoading),
				error: ref(error),
				refetch: vi.fn(),
			};
		}
		return { data: ref(undefined), isLoading: ref(false), error: ref(null), refetch: vi.fn() };
	});
}

const passthrough = { template: '<div><slot /></div>' };

const globalOptions = {
	stubs: {
		Icon: true,
		UiIconBox: true,
		UiBadge: true,
		UiSkeleton: true,
		UiSkeletonText: true,
		// Renders its action slot: the way forward out of the terminal state is
		// the empty state's OWN action now that the page-level "Back to delivery
		// setup" link is gone (the admin rail and the breadcrumb carry that).
		UiEmptyState: {
			props: ['title'],
			template: '<div data-testid="empty-state" :title="title"><slot name="action" /></div>',
		},
		UiSpinner: true,
		UiErrorAlert: true,
		DeliveryReferenceRelayNotice: true,
		DeliveryTransportEditor: true,
		DeliveryTransportConnectionWizard: true,
		DeliveryMtaStsModeCard: true,
		DeliveryTrustedForwardersCard: true,
		DeliveryTestSendCard: true,
		DeliverySignedWebhookCard: true,
		DeliverySnsTopicCard: true,
		DeliveryTlsReportCard: true,
		UiCard: passthrough,
	},
	components: { UiQueryBoundary: QueryBoundary, DeliveryTransportCanSendCard },
	plugins: [createTestI18n()],
};

describe('the delivery transport page never renders a bare header', () => {
	it('stands in for the cards that are coming while the status is in flight', () => {
		stubPage({ status: undefined, isLoading: true, error: null });
		const wrapper = mount(TransportPage, { global: globalOptions });

		// Content-shaped, not a single centred spinner: the status card's icon
		// disc and heading plus two configuration cards' worth of rows.
		expect(wrapper.findAll('ui-skeleton-stub').length).toBeGreaterThan(4);
		expect(wrapper.find('ui-skeleton-text-stub').exists()).toBe(true);
		expect(wrapper.html()).not.toContain('animate-spin');
		// The header stays put, so nothing above the fold moves when data lands.
		expect(wrapper.text()).toContain(en.dashboard.admin.delivery.transport.title);
	});

	it('names the terminal state when the query resolves with no status at all', () => {
		stubPage({ status: null, isLoading: false, error: null });
		const wrapper = mount(TransportPage, { global: globalOptions });

		const empty = wrapper.find('[data-testid="empty-state"]');
		expect(empty.exists()).toBe(true);
		expect(empty.attributes('title')).toBe(en.dashboard.admin.delivery.transport.empty.title);
		// A way forward, not a dead end.
		expect(wrapper.html()).toContain('/dashboard/admin/delivery');
		expect(wrapper.find('ui-skeleton-stub').exists()).toBe(false);
	});

	it('renders the real cards — and no placeholder — once the status arrives', () => {
		stubPage({ status: transportStatus(), isLoading: false, error: null });
		const wrapper = mount(TransportPage, { global: globalOptions });

		expect(wrapper.find('delivery-transport-editor-stub').exists()).toBe(true);
		expect(wrapper.text()).toContain(en.dashboard.admin.delivery.transport.canSend.yes);
		expect(wrapper.find('ui-skeleton-stub').exists()).toBe(false);
		expect(wrapper.find('ui-empty-state-stub').exists()).toBe(false);
	});

	it('shows the error alert rather than an empty state when the query faults', () => {
		stubPage({ status: undefined, isLoading: false, error: new Error('forbidden') });
		const wrapper = mount(TransportPage, { global: globalOptions });

		expect(wrapper.find('ui-error-alert-stub').exists()).toBe(true);
		expect(wrapper.find('ui-empty-state-stub').exists()).toBe(false);
		expect(wrapper.find('ui-skeleton-stub').exists()).toBe(false);
	});
});
