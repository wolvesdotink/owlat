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
