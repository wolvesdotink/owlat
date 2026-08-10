// @vitest-environment happy-dom
/**
 * WHO GETS A HAND ON THE RAMP.
 *
 * Both queries behind the controls screen are all-members — what the controller
 * is doing, and what it pulled back, is not privileged information — while every
 * write is an `adminMutation`, ENROLMENT INCLUDED. Rendering the controls for an
 * editor is therefore rendering buttons whose only possible answer is
 * `forbidden`, and the operator learns their permissions from a failed write.
 *
 * The gate takes the cell picker with it — it is the selector for those writes —
 * so the COPY is gated as well: neither the lede nor the explanation may promise
 * a member per-cell state this page no longer renders for them, and the member's
 * page has to point at the cells screen, which shows it to everyone.
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
import ControlsPage from '../advanced/controls.vue';
import RampCellControls from '~/components/delivery/RampCellControls.vue';
import RampDecreaseNotices from '~/components/delivery/RampDecreaseNotices.vue';
import RampPresetPicker from '~/components/delivery/RampPresetPicker.vue';
import QueryBoundary from '~/components/ui/QueryBoundary.vue';
import {
	adminNotice,
	cellControl,
	controlsView,
} from '~/components/delivery/__tests__/rampFixtures';
import type { RampControls } from '~/utils/deliverabilityRamp';

/** The one cell the picker offers has never been ramp-managed. */
const unmanaged = controlsView({ cells: [cellControl({ isRampManaged: false })] });

const ALARM = /text-error|bg-error|setup incomplete|action required|denied|forbidden/i;

function stubPage(
	permissions: { canManage: boolean; gate: boolean },
	view: RampControls = controlsView()
): void {
	vi.stubGlobal('useHead', vi.fn());
	vi.stubGlobal('definePageMeta', vi.fn());
	vi.stubGlobal('useBackendOperation', () => ({ run: vi.fn(), isLoading: ref(false) }));
	vi.stubGlobal('usePermissions', () => ({
		canManageOrganization: ref(permissions.canManage),
		showAdminGate: ref(permissions.gate),
	}));
	const answers = new Map<string, unknown>([
		[getFunctionName(api.delivery.rampControlQueries.getRampControls), view],
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
		NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
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
		expect(wrapper.find('[data-testid="ramp-controls-lede-actions"]').exists()).toBe(true);
		// The per-cell promise belongs to the page that keeps the cell picker.
		expect(wrapper.find('header').text()).toMatch(/what each stream is carrying/i);
		wrapper.unmount();
	});

	/**
	 * ENROLMENT IS A WRITE LIKE THE REST. It arrives on the same card and through
	 * the same `adminMutation`, so it is offered and withheld on the same terms —
	 * and it is the one control an unmanaged cell shows, which is exactly the cell
	 * a member is most likely to be looking at.
	 */
	it('offers the enrol affordance to an admin, and to nobody else', async () => {
		stubPage({ canManage: true, gate: false }, unmanaged);
		const admin = mount(ControlsPage, { global: globalOptions });
		await admin.find('[data-testid="ramp-select-campaign:gmail"]').trigger('click');
		expect(admin.find('[data-testid="ramp-control-enroll"]').exists()).toBe(true);
		admin.unmount();

		stubPage({ canManage: false, gate: true }, unmanaged);
		const member = mount(ControlsPage, { global: globalOptions });
		// No picker, so no selection, so no card — the affordance has no reachable
		// route rather than a hidden button.
		expect(member.find('[data-testid="ramp-select-campaign:gmail"]').exists()).toBe(false);
		expect(member.find('[data-testid="ramp-control-enroll"]').exists()).toBe(false);
		expect(member.find('[data-testid="ramp-controls-unmanaged"]').exists()).toBe(false);
		// The gate's own sentence has to name what it is withholding.
		expect(member.find('[data-testid="ramp-controls-admin-only"]').text()).toMatch(
			/putting a cell on it/i
		);
		member.unmount();
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

		// THE HEADER IS A WRITE SURFACE TOO. A lede that opens "hold a cell, cap
		// it, push it" is the page still offering, one paragraph above the gate,
		// exactly the buttons the gate has just taken away.
		expect(wrapper.find('[data-testid="ramp-controls-lede-actions"]').exists()).toBe(false);
		expect(wrapper.find('header').text()).not.toMatch(/hold a cell/i);
		expect(wrapper.find('header').text()).toMatch(/pulled back on its own/i);

		// AND THE COPY MAY NOT PROMISE THE CELL PICKER EITHER. The picker is the
		// selector for the writes, so the gate takes every per-cell share with it:
		// a member's page may neither claim each stream's state up top nor claim
		// that everything the controller is doing is below, and has to point at the
		// cells screen, which shows the same shares to all members.
		expect(wrapper.find('header').text()).not.toMatch(/each stream is carrying/i);
		expect(explanation.text()).not.toMatch(/everything the controller is doing/i);
		const cellsLink = wrapper.find('[data-testid="ramp-controls-cells-link"]');
		expect(cellsLink.exists()).toBe(true);
		expect(cellsLink.attributes('href')).toBe('/dashboard/admin/delivery/advanced/cells');

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
		// The lede's neutral sentence is true whoever is reading, so it stands
		// while the role resolves — only the action clause waits.
		expect(wrapper.find('header').text()).toMatch(/pulled back on its own/i);
		expect(wrapper.find('[data-testid="ramp-controls-lede-actions"]').exists()).toBe(false);
		wrapper.unmount();
	});
});
