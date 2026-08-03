// @vitest-environment happy-dom
/**
 * A SECONDARY READ THAT FAILED IS NOT AN EMPTY RESULT.
 *
 * Every one of these screens makes more than one query, and only the first one
 * is wrapped in a boundary. The rest fall through to `data ?? []` and render the
 * EMPTY state of a query that never answered — which on these three screens is
 * not a neutral placeholder but affirmatively GOOD NEWS: "Nothing has been
 * pulled back", "Nothing is wrong", "Not connected" (a claim about the
 * deployment). The repo's own `QueryBoundary` docblock names this exact failure:
 * "without this boundary a faulted query renders either an infinite-feeling
 * spinner or a misleading empty state".
 *
 * The assertion that carries the weight in each case is the NEGATIVE one — the
 * reassuring sentence must be ABSENT — because a "couldn't load" line rendered
 * next to "nothing has been pulled back" has still told the operator the
 * controller is quiet.
 *
 * The query stub is keyed by `getFunctionName` and carries a per-query error, so
 * a screen that answered the wrong query's fault would fail here rather than
 * pass by coincidence.
 */
import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref, type Ref } from 'vue';
import { getFunctionName, type FunctionReference } from 'convex/server';
import { api } from '@owlat/api';
import CellsPage from '../cells.vue';
import ControlsPage from '../controls.vue';
import DeliveryHubPage from '../index.vue';
import DomainTable from '~/components/delivery/DomainTable.vue';
import RampCellsGrid from '~/components/delivery/RampCellsGrid.vue';
import RampCellControls from '~/components/delivery/RampCellControls.vue';
import RampConfirmDialog from '~/components/delivery/RampConfirmDialog.vue';
import RampDecisionTimeline from '~/components/delivery/RampDecisionTimeline.vue';
import RampDecreaseNotices from '~/components/delivery/RampDecreaseNotices.vue';
import RampPresetPicker from '~/components/delivery/RampPresetPicker.vue';
import MeasurementGateList from '~/components/delivery/MeasurementGateList.vue';
import PostmasterComplianceCard from '~/components/delivery/PostmasterComplianceCard.vue';
import QueryBoundary from '~/components/ui/QueryBoundary.vue';
import ErrorAlert from '@owlat/ui/components/ui/ErrorAlert.vue';
import {
	adminNotice,
	cellControl,
	controlsView,
} from '~/components/delivery/__tests__/rampFixtures';
import { cellView } from '~/components/delivery/__tests__/measurementFixtures';

type AnyQuery = FunctionReference<'query'>;

interface StubbedQuery {
	readonly data?: unknown;
	readonly error?: Error;
}

/** Stub every read on a screen, giving named ones a fault of their own. */
function stubQueries(answers: readonly (readonly [AnyQuery, StubbedQuery])[]): void {
	const byName = new Map(answers.map(([query, value]) => [getFunctionName(query), value]));
	vi.stubGlobal('useOrganizationQuery', (query: AnyQuery) => {
		const answer = byName.get(getFunctionName(query)) ?? {};
		const error: Ref<Error | null> = ref(answer.error ?? null);
		return {
			// A faulted query keeps whatever it had, which is nothing on a first read.
			data: ref(answer.error === undefined ? answer.data : undefined),
			isLoading: ref(false),
			error,
			refetch: vi.fn(),
		};
	});
}

beforeEach(() => {
	vi.stubGlobal('useHead', vi.fn());
	vi.stubGlobal('definePageMeta', vi.fn());
	vi.stubGlobal('navigateTo', vi.fn());
	vi.stubGlobal('useBackendOperation', () => ({ run: vi.fn(), isLoading: ref(false) }));
	// The controls screen renders its write cards only for a member who may manage
	// the organization; these suites are about the admin's view of it.
	vi.stubGlobal('usePermissions', () => ({
		canManageOrganization: ref(true),
		showAdminGate: ref(false),
	}));
});

const passthroughCard = { template: '<div><slot /></div>' };

const globalOptions = {
	stubs: {
		UiIconBox: true,
		Icon: true,
		UiSpinner: true,
		UiEmptyState: true,
		UiButton: { template: '<button><slot /></button>' },
		UiCard: passthroughCard,
	},
	components: {
		UiQueryBoundary: QueryBoundary,
		UiErrorAlert: ErrorAlert,
		DeliveryRampCellsGrid: RampCellsGrid,
		DeliveryRampCellControls: RampCellControls,
		DeliveryRampConfirmDialog: RampConfirmDialog,
		DeliveryRampDecisionTimeline: RampDecisionTimeline,
		DeliveryRampDecreaseNotices: RampDecreaseNotices,
		DeliveryRampPresetPicker: RampPresetPicker,
		DeliveryMeasurementGateList: MeasurementGateList,
	},
};

const dashboardView = {
	generatedAt: 0,
	windowStart: 0,
	windowEnd: 1,
	referenceTransportId: 'ses',
	isRelayConfigured: true,
	hasSeedCoverage: false,
	cells: [cellView()],
};

describe('the controls screen’s pull-back list', () => {
	it('does not say nothing was pulled back when the notices read failed', () => {
		stubQueries([
			[api.delivery.rampControlQueries.getRampControls, { data: controlsView() }],
			[
				api.delivery.rampControlQueries.listRampAdminNotices,
				{ error: new Error('notices unavailable') },
			],
		]);
		const wrapper = mount(ControlsPage, { global: globalOptions });

		expect(wrapper.find('[data-testid="ramp-notices-empty"]').exists()).toBe(false);
		expect(wrapper.text()).not.toContain('Nothing has been pulled back');
		expect(wrapper.text()).toContain('Couldn’t load the automatic pull-backs');
		// The screen's own read is fine, so the rest of it still renders.
		expect(wrapper.find('h1').text()).toBe('Delivery controls');
		wrapper.unmount();
	});

	it('still says nothing was pulled back when the read succeeded and was empty', () => {
		stubQueries([
			[api.delivery.rampControlQueries.getRampControls, { data: controlsView() }],
			[api.delivery.rampControlQueries.listRampAdminNotices, { data: [] }],
		]);
		const wrapper = mount(ControlsPage, { global: globalOptions });

		expect(wrapper.find('[data-testid="ramp-notices-empty"]').text()).toContain(
			'Nothing has been pulled back'
		);
		wrapper.unmount();
	});

	it('renders the retreats when the read succeeded and found some', () => {
		stubQueries([
			[api.delivery.rampControlQueries.getRampControls, { data: controlsView() }],
			[api.delivery.rampControlQueries.listRampAdminNotices, { data: [adminNotice()] }],
		]);
		const wrapper = mount(ControlsPage, { global: globalOptions });

		expect(wrapper.find('[data-testid="ramp-notices"]').exists()).toBe(true);
		wrapper.unmount();
	});
});

describe('the cells screen’s secondary reads', () => {
	function openFirstCell(cellKey: string) {
		const wrapper = mount(CellsPage, { global: globalOptions });
		return { wrapper, open: () => wrapper.find(`[data-testid="ramp-cell-open-${cellKey}"]`) };
	}

	it('does not say nothing is wrong when the evidence read failed', async () => {
		stubQueries([
			[
				api.delivery.rampControlQueries.getRampControls,
				{ data: controlsView({ cells: [cellControl()] }) },
			],
			[
				api.delivery.deliverabilityDashboard.getDeliverabilityDashboard,
				{ error: new Error('dashboard unavailable') },
			],
			[api.delivery.rampControlQueries.listCellDecisions, { data: [] }],
		]);
		const { wrapper, open } = openFirstCell('campaign:gmail');
		await open().trigger('click');

		expect(wrapper.find('[data-testid="ramp-evidence-absent"]').exists()).toBe(false);
		expect(wrapper.text()).not.toContain('Nothing is wrong');
		expect(wrapper.text()).toContain('Couldn’t load this cell’s evidence');
		wrapper.unmount();
	});

	it('does not say the controller never looked when the decision read failed', async () => {
		stubQueries([
			[
				api.delivery.rampControlQueries.getRampControls,
				{ data: controlsView({ cells: [cellControl()] }) },
			],
			[api.delivery.deliverabilityDashboard.getDeliverabilityDashboard, { data: dashboardView }],
			[api.delivery.rampControlQueries.listCellDecisions, { error: new Error('gone') }],
		]);
		const { wrapper, open } = openFirstCell('campaign:gmail');
		await open().trigger('click');

		expect(wrapper.find('[data-testid="ramp-timeline-empty"]').exists()).toBe(false);
		expect(wrapper.text()).not.toContain('No decisions recorded for this cell yet');
		expect(wrapper.text()).toContain('Couldn’t load this cell’s decision history');
		// One fault does not take the other read down with it.
		expect(wrapper.find('[data-testid="measurement-gate-list"]').exists()).toBe(true);
		wrapper.unmount();
	});

	it('keeps the calm empty sentences when both reads answered with nothing', async () => {
		stubQueries([
			[
				api.delivery.rampControlQueries.getRampControls,
				{ data: controlsView({ cells: [cellControl()] }) },
			],
			[
				api.delivery.deliverabilityDashboard.getDeliverabilityDashboard,
				{ data: { ...dashboardView, cells: [] } },
			],
			[api.delivery.rampControlQueries.listCellDecisions, { data: [] }],
		]);
		const { wrapper, open } = openFirstCell('campaign:gmail');
		await open().trigger('click');

		expect(wrapper.find('[data-testid="ramp-evidence-absent"]').text()).toContain(
			'Nothing is wrong'
		);
		expect(wrapper.find('[data-testid="ramp-timeline-empty"]').exists()).toBe(true);
		wrapper.unmount();
	});
});

describe('the Gmail compliance card', () => {
	const stubs = {
		Icon: { template: '<i />' },
		UiCard: { template: '<div><slot /></div>' },
		UiIconBox: { template: '<i />' },
	};

	it('does not report "Not connected" for an account it could not ask about', () => {
		const wrapper = mount(PostmasterComplianceCard, {
			props: { status: undefined, isLoading: false, error: new Error('postmaster unavailable') },
			global: { stubs },
		});

		expect(wrapper.find('[data-testid="postmaster-not-connected"]').exists()).toBe(false);
		expect(wrapper.find('[data-testid="postmaster-unavailable"]').text()).toContain(
			'Couldn’t load Gmail compliance'
		);
		wrapper.unmount();
	});

	it('still reads "Not connected" when the query answered that nobody has connected', () => {
		const wrapper = mount(PostmasterComplianceCard, {
			props: { status: { connected: false, domains: [] }, isLoading: false, error: null },
			global: { stubs },
		});

		expect(wrapper.find('[data-testid="postmaster-not-connected"]').exists()).toBe(true);
		expect(wrapper.find('[data-testid="postmaster-unavailable"]').exists()).toBe(false);
		wrapper.unmount();
	});
});

/**
 * THE SAME DEFECT, PINNED AT PAGE LEVEL.
 *
 * A card that handles its own fault correctly is only half the fix: the page has
 * to HAND it the fault. Mounting the cards directly leaves `:error="…"` a single
 * attribute nobody tests — delete it and the shipped bug is back with every suite
 * green. So the hub is mounted whole here, with the faults delivered through the
 * same keyed query stub, and both reassuring sentences are asserted ABSENT.
 */
describe('the delivery hub page', () => {
	/** The one read the page's own boundary gates — healthy in every case here. */
	const sendingOverview = {
		warming: null,
		volume: null,
		reputation: null,
		abuseStatus: 'clean',
	};

	function stubHubQueries(overrides: readonly (readonly [AnyQuery, StubbedQuery])[]): void {
		stubQueries([
			[api.analytics.reputationQueries.getSendingOverview, { data: sendingOverview }],
			[api.analytics.reputationSnapshots.getDeliverySnapshots, { data: [] }],
			[api.blockedEmails.getCountsByReason, { data: null }],
			...overrides,
		]);
	}

	const hubOptions = {
		stubs: {
			Icon: true,
			UiIconBox: true,
			UiSpinner: true,
			UiStatTile: true,
			UiTrendChart: true,
			DeliveryReadinessPanel: true,
			DeliveryTransportCard: true,
			DeliveryComplianceTelemetryCard: true,
			DeliverySendingDetails: true,
			UiCard: passthroughCard,
			UiButton: { template: '<button><slot /></button>' },
			NuxtLink: { template: '<a><slot /></a>' },
			// Rendered rather than shrugged off: the assertions below are about the
			// WORDS an empty state puts on the screen, and a `true` stub would make
			// every one of them pass against a component that rendered nothing.
			UiEmptyState: {
				props: ['icon', 'title', 'description'],
				template: '<div><h3>{{ title }}</h3><p>{{ description }}</p><slot name="action" /></div>',
			},
		},
		components: {
			UiQueryBoundary: QueryBoundary,
			UiErrorAlert: ErrorAlert,
			DeliveryPostmasterComplianceCard: PostmasterComplianceCard,
			DeliveryDomainTable: DomainTable,
		},
	};

	beforeEach(() => {
		vi.stubGlobal('useOrganizationContext', () => ({ isLoading: ref(false) }));
		vi.stubGlobal('useDeliveryHealth', () => ({
			level: ref('ok'),
			reason: ref(''),
			isVisible: ref(false),
			dotClass: ref(''),
		}));
	});

	it('does not report Gmail "Not connected" when the postmaster read failed', () => {
		stubHubQueries([
			[api.analytics.reputationQueries.getDeliveryDomainTable, { data: [] }],
			[api.delivery.postmaster.getPostmasterStatus, { error: new Error('postmaster unavailable') }],
		]);
		const wrapper = mount(DeliveryHubPage, { global: hubOptions });

		expect(wrapper.find('[data-testid="postmaster-not-connected"]').exists()).toBe(false);
		expect(wrapper.text()).not.toContain('Not connected');
		expect(wrapper.find('[data-testid="postmaster-unavailable"]').exists()).toBe(true);
		wrapper.unmount();
	});

	it('does not say there are no sending domains when the domain read failed', () => {
		stubHubQueries([
			[
				api.analytics.reputationQueries.getDeliveryDomainTable,
				{ error: new Error('domains unavailable') },
			],
			[api.delivery.postmaster.getPostmasterStatus, { data: { connected: false, domains: [] } }],
		]);
		const wrapper = mount(DeliveryHubPage, { global: hubOptions });

		// The empty state points into the domain SETUP flow, which is the wrong
		// place to send an operator whose domains are set up and unreadable.
		expect(wrapper.text()).not.toContain('No sending domains yet');
		expect(wrapper.text()).not.toContain('Add a domain and publish its DNS records');
		expect(wrapper.text()).toContain('Couldn’t load your sending domains');
		wrapper.unmount();
	});

	it('does not say history is still being collected when the history read failed', () => {
		// "Collecting history — full trends in a week" is a claim about how long
		// this DEPLOYMENT has been sending. A faulted read leaves behind the same
		// empty array a week-old install has, so an operator with three weeks of
		// sending behind them was told the product had only just met them.
		stubHubQueries([
			[api.analytics.reputationQueries.getDeliveryDomainTable, { data: [] }],
			[api.delivery.postmaster.getPostmasterStatus, { data: { connected: false, domains: [] } }],
			[
				api.analytics.reputationSnapshots.getDeliverySnapshots,
				{ error: new Error('snapshots unavailable') },
			],
		]);
		const wrapper = mount(DeliveryHubPage, { global: hubOptions });

		expect(wrapper.text()).not.toContain('Collecting history');
		expect(wrapper.text()).toContain('Couldn’t load your delivery-rate history');
		wrapper.unmount();
	});

	it('keeps both calm empty states when the two reads answered with nothing', () => {
		stubHubQueries([
			[api.analytics.reputationQueries.getDeliveryDomainTable, { data: [] }],
			[api.delivery.postmaster.getPostmasterStatus, { data: { connected: false, domains: [] } }],
		]);
		const wrapper = mount(DeliveryHubPage, { global: hubOptions });

		expect(wrapper.find('[data-testid="postmaster-not-connected"]').exists()).toBe(true);
		expect(wrapper.text()).toContain('No sending domains yet');
		// The history read ANSWERED, with nothing, so the sentence about a young
		// deployment is earned and stays.
		expect(wrapper.text()).toContain('Collecting history');
		wrapper.unmount();
	});
});
