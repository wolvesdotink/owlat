// @vitest-environment happy-dom
/**
 * WHO GETS A HAND ON THE RAMP.
 *
 * Both queries behind the controls screen are all-members — what the controller
 * is doing, and what it pulled back, is not privileged information — while all
 * five writes are `adminMutation`. Rendering the controls for an editor is
 * therefore rendering five buttons whose only possible answer is `forbidden`,
 * and the operator learns their permissions from a failed write.
 *
 * The third case is the one worth having a test for: the role has not RESOLVED
 * yet. Neither the controls nor the "admins only" sentence may appear then — an
 * admin must not watch their own controls get taken away on first paint, and a
 * member must not see them offered at all.
 */
import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { getFunctionName, type FunctionReference } from 'convex/server';
import { api } from '@owlat/api';
import ControlsPage from '../controls.vue';
import RampCellControls from '~/components/delivery/RampCellControls.vue';
import RampDecreaseNotices from '~/components/delivery/RampDecreaseNotices.vue';
import RampPresetPicker from '~/components/delivery/RampPresetPicker.vue';
import QueryBoundary from '~/components/ui/QueryBoundary.vue';
import { adminNotice, controlsView } from '~/components/delivery/__tests__/rampFixtures';

const ALARM = /text-error|bg-error|setup incomplete|action required|denied|forbidden/i;

function stubPage(permissions: { canManage: boolean; gate: boolean }): void {
	vi.stubGlobal('useHead', vi.fn());
	vi.stubGlobal('definePageMeta', vi.fn());
	vi.stubGlobal('useBackendOperation', () => ({ run: vi.fn(), isLoading: ref(false) }));
	vi.stubGlobal('usePermissions', () => ({
		canManageOrganization: ref(permissions.canManage),
		showAdminGate: ref(permissions.gate),
	}));
	const answers = new Map<string, unknown>([
		[getFunctionName(api.delivery.rampControlQueries.getRampControls), controlsView()],
		[getFunctionName(api.delivery.rampControlQueries.listRampAdminNotices), [adminNotice()]],
	]);
	vi.stubGlobal('useOrganizationQuery', (query: FunctionReference<'query'>) => ({
		data: ref(answers.get(getFunctionName(query))),
		isLoading: ref(false),
		error: ref(null),
		refetch: vi.fn(),
	}));
}

const passthroughCard = { template: '<div><slot /></div>' };

const globalOptions = {
	stubs: {
		UiIconBox: true,
		Icon: true,
		UiSpinner: true,
		UiEmptyState: true,
		UiCard: passthroughCard,
		DeliveryRampConfirmDialog: true,
	},
	components: {
		UiQueryBoundary: QueryBoundary,
		DeliveryRampCellControls: RampCellControls,
		DeliveryRampDecreaseNotices: RampDecreaseNotices,
		DeliveryRampPresetPicker: RampPresetPicker,
	},
};

describe('the ramp controls are admin-only', () => {
	it('offers every control to a member who may manage the organization', () => {
		stubPage({ canManage: true, gate: false });
		const wrapper = mount(ControlsPage, { global: globalOptions });
		expect(wrapper.find('[data-testid="ramp-select-campaign:gmail"]').exists()).toBe(true);
		expect(wrapper.find('[data-testid="ramp-preset-campaign"]').exists()).toBe(true);
		expect(wrapper.find('[data-testid="ramp-controls-admin-only"]').exists()).toBe(false);
		wrapper.unmount();
	});

	it('renders no write control for a member who may not, and says why', () => {
		stubPage({ canManage: false, gate: true });
		const wrapper = mount(ControlsPage, { global: globalOptions });

		expect(wrapper.find('[data-testid="ramp-select-campaign:gmail"]').exists()).toBe(false);
		expect(wrapper.find('[data-testid="ramp-control-pause"]').exists()).toBe(false);
		expect(wrapper.find('[data-testid="ramp-preset-campaign"]').exists()).toBe(false);
		expect(wrapper.findAll('fieldset')).toEqual([]);

		const explanation = wrapper.find('[data-testid="ramp-controls-admin-only"]');
		expect(explanation.exists()).toBe(true);
		expect(explanation.text()).toMatch(/owners and admins/i);

		// THE READS STAY. What the controller pulled back is all-members
		// information, and hiding it would turn a permission into a blind spot.
		expect(wrapper.find('[data-testid="ramp-notices"]').exists()).toBe(true);
		expect(wrapper.html()).not.toMatch(ALARM);
		wrapper.unmount();
	});

	it('shows neither the controls nor the explanation until the role resolves', () => {
		// `canManageOrganization` is false and `showAdminGate` is false only while
		// the role is still loading — an admin must not read "admins only" about
		// their own screen on first paint.
		stubPage({ canManage: false, gate: false });
		const wrapper = mount(ControlsPage, { global: globalOptions });
		expect(wrapper.find('[data-testid="ramp-select-campaign:gmail"]').exists()).toBe(false);
		expect(wrapper.find('[data-testid="ramp-controls-admin-only"]').exists()).toBe(false);
		wrapper.unmount();
	});
});
