// @vitest-environment happy-dom
/**
 * Delivery → Advanced before the ramp has started: the cell grid and the
 * controls say what fills them and point at Migrate from Mailchimp, instead of
 * a table header over no rows.
 */
import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref, type Ref } from 'vue';
import { getFunctionName, type FunctionReference } from 'convex/server';
import { api } from '@owlat/api';
import CellsPage from '../advanced/cells.vue';
import ControlsPage from '../advanced/controls.vue';
import RampCellsGrid from '~/components/delivery/RampCellsGrid.vue';
import RampCellControls from '~/components/delivery/RampCellControls.vue';
import RampPresetPicker from '~/components/delivery/RampPresetPicker.vue';
import RampDecreaseNotices from '~/components/delivery/RampDecreaseNotices.vue';
import QueryBoundary from '~/components/ui/QueryBoundary.vue';
import { cellControl, controlsView } from '~/components/delivery/__tests__/rampFixtures';
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
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('useHead', vi.fn());
	vi.stubGlobal('definePageMeta', vi.fn());
	vi.stubGlobal('navigateTo', vi.fn());
	vi.stubGlobal('useBackendOperation', () => ({ run: vi.fn(), isLoading: ref(false) }));
	vi.stubGlobal('usePermissions', () => ({
		canManageOrganization: ref(true),
		showAdminGate: ref(false),
	}));
});

const globalOptions = {
	stubs: {
		UiIconBox: true,
		Icon: true,
		UiSpinner: true,
		UiEmptyState: {
			props: ['title', 'description'],
			template:
				'<div data-testid="empty-state"><strong>{{ title }}</strong><p>{{ description }}</p><slot name="action" /></div>',
		},
		UiButton: {
			props: ['to'],
			template:
				'<a v-if="to" :href="to"><slot /></a><button v-else type="button"><slot /></button>',
		},
		NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
		UiCard: { template: '<div><slot /></div>' },
		DeliveryReferenceRelayNotice: true,
		DeliveryRampConfirmDialog: true,
		DeliveryMeasurementGateList: true,
		DeliveryRampDecisionTimeline: true,
		UiErrorAlert: true,
	},
	components: {
		UiQueryBoundary: QueryBoundary,
		DeliveryRampCellsGrid: RampCellsGrid,
		DeliveryRampCellControls: RampCellControls,
		DeliveryRampPresetPicker: RampPresetPicker,
		DeliveryRampDecreaseNotices: RampDecreaseNotices,
	},
	plugins: [createTestI18n()],
};

const unmanaged = [
	cellControl({ isRampManaged: false }),
	cellControl({
		cellKey: 'campaign:microsoft',
		cell: { stream: 'campaign', destinationProvider: 'microsoft' },
		isRampManaged: false,
	}),
];

describe('cells screen before the ramp starts', () => {
	it('explains the empty grid and links to Migrate from Mailchimp', () => {
		stubQueries([
			[api.delivery.rampControlQueries.getRampControls, controlsView({ cells: unmanaged })],
		]);
		const wrapper = mount(CellsPage, { global: globalOptions });
		const empty = wrapper.find('[data-testid="delivery-advanced-empty"]');
		expect(empty.exists()).toBe(true);
		expect(empty.text()).toContain('No delivery cells in use yet');
		expect(empty.text()).toContain('relay and your own server share traffic');
		expect(empty.find('a').attributes('href')).toBe('/dashboard/admin/delivery/migrate');
		expect(wrapper.find('[data-testid="ramp-cells-grid"]').exists()).toBe(false);
		wrapper.unmount();
	});

	it('shows the grid once one cell is managed', () => {
		stubQueries([
			[
				api.delivery.rampControlQueries.getRampControls,
				controlsView({ cells: [...unmanaged, cellControl({ cellKey: 'x' })] }),
			],
		]);
		const wrapper = mount(CellsPage, { global: globalOptions });
		expect(wrapper.find('[data-testid="delivery-advanced-empty"]').exists()).toBe(false);
		expect(wrapper.find('[data-testid="ramp-cells-grid"]').exists()).toBe(true);
		wrapper.unmount();
	});
});

describe('controls screen before the ramp starts', () => {
	it('shows the empty state when there are no cells at all', () => {
		stubQueries([[api.delivery.rampControlQueries.getRampControls, controlsView({ cells: [] })]]);
		const wrapper = mount(ControlsPage, { global: globalOptions });
		const empty = wrapper.find('[data-testid="delivery-advanced-empty"]');
		expect(empty.exists()).toBe(true);
		expect(empty.text()).toContain('No cells to control yet');
		wrapper.unmount();
	});

	it('keeps the controls but says where to begin when no cell is managed', () => {
		stubQueries([
			[api.delivery.rampControlQueries.getRampControls, controlsView({ cells: unmanaged })],
		]);
		const wrapper = mount(ControlsPage, { global: globalOptions });
		const idle = wrapper.find('[data-testid="ramp-controls-idle"]');
		expect(idle.exists()).toBe(true);
		expect(idle.find('a').attributes('href')).toBe('/dashboard/admin/delivery/migrate');
		expect(wrapper.find(`[data-testid="ramp-select-${unmanaged[0]?.cellKey}"]`).exists()).toBe(
			true
		);
		wrapper.unmount();
	});

	it('says nothing extra once the ramp manages a cell', () => {
		stubQueries([[api.delivery.rampControlQueries.getRampControls, controlsView()]]);
		const wrapper = mount(ControlsPage, { global: globalOptions });
		expect(wrapper.find('[data-testid="ramp-controls-idle"]').exists()).toBe(false);
		expect(wrapper.find('[data-testid="delivery-advanced-empty"]').exists()).toBe(false);
		wrapper.unmount();
	});
});
