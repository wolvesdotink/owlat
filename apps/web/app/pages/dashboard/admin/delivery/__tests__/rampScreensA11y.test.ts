// @vitest-environment happy-dom
/**
 * THE ACCESSIBILITY PASS ACROSS ALL THREE SCREENS.
 *
 * MOUNTED, NOT LINTED. The properties here — one h1 per page, an h2 above any
 * h3, an accessible name on every focusable control, header cells on every
 * table, an announceable loading state, and no information carried by colour
 * alone — are properties of the RENDERED page. A static check passes on a
 * heading inside a comment and on an `aria-label` bound to nothing.
 *
 * THE QUERY STUB IS KEYED BY THE QUERY'S NAME. Each screen makes more than one
 * read, and a stub that answered every call with the same payload would let a
 * page render its cell grid out of an independence summary and still pass. The
 * key is `getFunctionName`, not the reference itself: `api.x.y` is a proxy that
 * mints a fresh object on every property access, so identity comparison would
 * silently match nothing and every query would answer `undefined`.
 */
import { mount, type VueWrapper } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref, type Ref } from 'vue';
import { getFunctionName, type FunctionReference } from 'convex/server';
import { api } from '@owlat/api';
import IndependencePage from '../advanced/independence.vue';
import CellsPage from '../advanced/cells.vue';
import ControlsPage from '../advanced/controls.vue';
import IndependenceTrendChart from '~/components/delivery/IndependenceTrendChart.vue';
import RampCellsGrid from '~/components/delivery/RampCellsGrid.vue';
import RampCellControls from '~/components/delivery/RampCellControls.vue';
import RampConfirmDialog from '~/components/delivery/RampConfirmDialog.vue';
import RampDecisionTimeline from '~/components/delivery/RampDecisionTimeline.vue';
import RampDecreaseNotices from '~/components/delivery/RampDecreaseNotices.vue';
import RampPresetPicker from '~/components/delivery/RampPresetPicker.vue';
import MeasurementGateList from '~/components/delivery/MeasurementGateList.vue';
import QueryBoundary from '~/components/ui/QueryBoundary.vue';
import {
	adminNotice,
	cellControl,
	controlsView,
	independenceSummary,
} from '~/components/delivery/__tests__/rampFixtures';
import { cellView } from '~/components/delivery/__tests__/measurementFixtures';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

const isLoading = ref(false);
const error: Ref<Error | null> = ref(null);

type AnyQuery = FunctionReference<'query'>;

function stubQueries(answers: readonly (readonly [AnyQuery, unknown])[]): void {
	const byName = new Map(answers.map(([query, value]) => [getFunctionName(query), value]));
	vi.stubGlobal('useOrganizationQuery', (query: AnyQuery) => ({
		data: ref(byName.get(getFunctionName(query))),
		isLoading,
		error,
		refetch: vi.fn(),
	}));
}

beforeEach(() => {
	isLoading.value = false;
	error.value = null;
	// These screens' copy flows through vue-i18n now; `useI18n` is a Nuxt
	// auto-import, so it has to exist as a bare global for their setups.
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
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
		UiCard: passthroughCard,
	},
	components: {
		UiQueryBoundary: QueryBoundary,
		DeliveryIndependenceTrendChart: IndependenceTrendChart,
		DeliveryRampCellsGrid: RampCellsGrid,
		DeliveryRampCellControls: RampCellControls,
		DeliveryRampConfirmDialog: RampConfirmDialog,
		DeliveryRampDecisionTimeline: RampDecisionTimeline,
		DeliveryRampDecreaseNotices: RampDecreaseNotices,
		DeliveryRampPresetPicker: RampPresetPicker,
		DeliveryMeasurementGateList: MeasurementGateList,
	},
	plugins: [createTestI18n()],
};

/** Every focusable element must have an accessible name from somewhere. */
function unnamedControls(wrapper: VueWrapper): string[] {
	const offenders: string[] = [];
	for (const control of wrapper.findAll('button, a[href], input, select, textarea')) {
		const element = control.element as HTMLElement;
		const hasText = element.textContent !== null && element.textContent.trim().length > 0;
		const hasAria =
			element.getAttribute('aria-label') !== null ||
			element.getAttribute('aria-labelledby') !== null;
		const id = element.getAttribute('id');
		const hasLabel = id !== null && wrapper.find(`label[for="${id}"]`).exists();
		const isWrappedInLabel = element.closest('label') !== null;
		if (!hasText && !hasAria && !hasLabel && !isWrappedInLabel) {
			offenders.push(element.outerHTML.slice(0, 120));
		}
	}
	return offenders;
}

function expectHeadingOrder(wrapper: VueWrapper): void {
	expect(wrapper.findAll('h1')).toHaveLength(1);
	if (wrapper.findAll('h3').length > 0) {
		expect(wrapper.findAll('h2').length).toBeGreaterThan(0);
	}
}

describe('independence screen accessibility', () => {
	beforeEach(() => {
		stubQueries([[api.delivery.rampIndependence.getIndependenceSummary, independenceSummary()]]);
	});

	it('owns one h1 and names every control', () => {
		const wrapper = mount(IndependencePage, { global: globalOptions });
		expectHeadingOrder(wrapper);
		expect(unnamedControls(wrapper)).toEqual([]);
		wrapper.unmount();
	});

	it('announces its loading state instead of labelling a bare div', () => {
		isLoading.value = true;
		const wrapper = mount(IndependencePage, { global: globalOptions });
		const status = wrapper.find('[role="status"]');
		expect(status.exists()).toBe(true);
		expect(status.attributes('aria-live')).toBe('polite');
		expect(status.attributes('aria-label')).toBe('Loading independence figures');
		wrapper.unmount();
	});

	it('does not carry the arm split by colour alone', () => {
		const wrapper = mount(IndependenceTrendChart, {
			props: { points: independenceSummary().series, hasReference: true, labelledBy: 'x' },
			global: { plugins: [createTestI18n()] },
		});
		expect(wrapper.find('svg[role="img"]').attributes('aria-label')).toBeTruthy();
		// The relay band is painted with a PATTERN, not merely a second colour, and
		// the pattern id is document-unique so two charts on one page cannot share
		// (and silently overwrite) it.
		const fill = wrapper.find('[data-testid="reference-band"]').attributes('fill') ?? '';
		expect(fill).toMatch(/^url\(#.+\)$/);
		const patternId = wrapper.find('pattern').attributes('id');
		expect(patternId).toBeTruthy();
		expect(fill).toBe(`url(#${patternId})`);
		expect(wrapper.find('table caption').exists()).toBe(true);
		wrapper.unmount();
	});
});

describe('cells screen accessibility', () => {
	beforeEach(() => {
		stubQueries([
			[api.delivery.rampControlQueries.getRampControls, controlsView()],
			[
				api.delivery.deliverabilityDashboard.getDeliverabilityDashboard,
				{
					generatedAt: 0,
					windowStart: 0,
					windowEnd: 1,
					decisionWindowStart: 0,
					decisionWindowEnd: 1,
					referenceTransportId: 'ses',
					isRelayConfigured: true,
					hasSeedCoverage: false,
					cells: [cellView()],
				},
			],
			[api.delivery.rampControlQueries.listCellDecisions, []],
		]);
	});

	it('presents the grid as a labelled table with row and column headers', () => {
		const wrapper = mount(CellsPage, { global: globalOptions });
		expectHeadingOrder(wrapper);
		const table = wrapper.find('[data-testid="ramp-cells-grid"]');
		expect(table.attributes('aria-labelledby')).toBeTruthy();
		expect(wrapper.find(`#${table.attributes('aria-labelledby')}`).exists()).toBe(true);
		expect(wrapper.findAll('th[scope="col"]').length).toBeGreaterThan(0);
		expect(wrapper.findAll('th[scope="row"]').length).toBeGreaterThan(0);
		expect(unnamedControls(wrapper)).toEqual([]);
		wrapper.unmount();
	});
});

describe('controls screen accessibility', () => {
	beforeEach(() => {
		stubQueries([
			[api.delivery.rampControlQueries.getRampControls, controlsView({ cells: [cellControl()] })],
			[api.delivery.rampControlQueries.listRampAdminNotices, [adminNotice()]],
		]);
	});

	it('labels every input, groups the presets in fieldsets, and names each button', () => {
		const wrapper = mount(ControlsPage, { global: globalOptions });
		expectHeadingOrder(wrapper);
		expect(unnamedControls(wrapper)).toEqual([]);
		expect(wrapper.findAll('fieldset').length).toBe(3);
		for (const fieldset of wrapper.findAll('fieldset')) {
			expect(fieldset.find('legend').exists()).toBe(true);
		}
		wrapper.unmount();
	});

	it('gives the confirmation dialog a modal role, a name and a description', async () => {
		const wrapper = mount(ControlsPage, { global: globalOptions });
		await wrapper.find('[data-testid="ramp-select-campaign:gmail"]').trigger('click');
		await wrapper.find('[data-testid="ramp-control-force-advance"]').trigger('click');
		const dialog = wrapper.find('[role="dialog"]');
		expect(dialog.attributes('aria-modal')).toBe('true');
		expect(dialog.attributes('aria-labelledby')).toBeTruthy();
		expect(dialog.attributes('aria-describedby')).toBeTruthy();
		wrapper.unmount();
	});

	it('labels the pull-back list programmatically', () => {
		const wrapper = mount(RampDecreaseNotices, {
			props: { notices: [adminNotice()], labelledBy: 'notices-heading' },
			global: { plugins: [createTestI18n()] },
		});
		expect(wrapper.attributes('aria-labelledby')).toBe('notices-heading');
		wrapper.unmount();
	});
});
