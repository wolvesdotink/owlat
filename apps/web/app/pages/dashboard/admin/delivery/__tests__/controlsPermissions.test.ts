// @vitest-environment happy-dom
/**
 * WHO GETS A HAND ON THE RAMP — and where that is decided.
 *
 * Both queries behind the controls screen are all-members (what the controller is
 * doing, and what it pulled back, is not privileged information) while every write
 * is an `adminMutation`, ENROLMENT INCLUDED. Rendering the controls for an editor
 * would be rendering buttons whose only possible answer is `forbidden`.
 *
 * THE ROUTE IS WHAT PREVENTS THAT, not the template. The page declares
 * `middleware: ['auth', 'admin']`; that middleware waits for the role to resolve
 * and sends a non-admin to /dashboard before the page renders, and with
 * `ssr: false` it always runs. The screen used to ALSO carry an in-template
 * "admins only" card with a member-specific lede and a pointer at the cells
 * screen — three variants of copy for a reader who never arrives. Those are gone;
 * app/__tests__/adminGatingParity.test.ts is what fails if any Administration
 * page loses the middleware that replaced them.
 *
 * What is left to pin here is the other half, and it is the half that regresses
 * quietly: every control this page owns is offered UNCONDITIONALLY to the reader
 * who does arrive. A stray `v-if` left behind by the gate's removal would hide a
 * control from the only person who can use it.
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

function stubPage(view: RampControls = controlsView()): void {
	vi.stubGlobal('useHead', vi.fn());
	vi.stubGlobal('definePageMeta', vi.fn());
	vi.stubGlobal('useBackendOperation', () => ({ run: vi.fn(), isLoading: ref(false) }));
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

describe('the ramp controls are admin-only, and the route is the gate', () => {
	it('offers every control to the admin the route let through', () => {
		stubPage();
		const wrapper = mount(ControlsPage, { global: globalOptions });
		expect(wrapper.find('[data-testid="ramp-select-campaign:gmail"]').exists()).toBe(true);
		expect(wrapper.find('[data-testid="ramp-preset-campaign"]').exists()).toBe(true);
		// The lede promises the controls unconditionally now — it used to add this
		// clause only once the role resolved, and had nothing to hedge against.
		expect(wrapper.find('[data-testid="ramp-controls-lede-actions"]').exists()).toBe(true);
		expect(wrapper.find('header').text()).toMatch(/what each stream is carrying/i);
		expect(wrapper.find('header').text()).toMatch(/pulled back on its own/i);
		wrapper.unmount();
	});

	/**
	 * ENROLMENT IS A WRITE LIKE THE REST. It arrives on the same card and through
	 * the same `adminMutation`, and it is the one control an UNMANAGED cell shows —
	 * the state a fresh deployment is entirely made of. A `v-if` that survived the
	 * gate's removal here would leave the one reachable control unreachable.
	 */
	it('offers the enrol affordance on a cell the ramp has never taken over', async () => {
		stubPage(unmanaged);
		const wrapper = mount(ControlsPage, { global: globalOptions });
		await wrapper.find('[data-testid="ramp-select-campaign:gmail"]').trigger('click');
		expect(wrapper.find('[data-testid="ramp-control-enroll"]').exists()).toBe(true);
		wrapper.unmount();
	});

	it('renders no per-cell card until a cell is picked', () => {
		// The remaining condition on that card is the SELECTION, not a permission.
		stubPage();
		const wrapper = mount(ControlsPage, { global: globalOptions });
		expect(wrapper.find('[data-testid="ramp-control-pause"]').exists()).toBe(false);
		wrapper.unmount();
	});

	it('shows the all-members reads calmly, with no alarm styling', () => {
		// What the controller pulled back is information, not a fault: the pull-back
		// list is the reason this screen is worth loading even when nothing is wrong.
		stubPage();
		const wrapper = mount(ControlsPage, { global: globalOptions });
		expect(wrapper.find('[data-testid="ramp-notices"]').exists()).toBe(true);
		expect(wrapper.html()).not.toMatch(ALARM);
		wrapper.unmount();
	});
});
