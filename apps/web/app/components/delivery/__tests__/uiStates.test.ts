// @vitest-environment happy-dom
/**
 * THE STATES ARE THE FEATURE (plan D2, D10, D14).
 *
 * insufficient_data, zero volume, no relay, no integration and low confidence are
 * the states a real deployment spends most of its life in. Every one of them must
 * render CALMLY, with a concrete thing the operator could do if they want to —
 * never a warning, never a nag, never a "setup incomplete".
 *
 * The assertion that carries the most weight is the negative one: no error tone
 * anywhere in these states. A screen that says the right words in an alarming
 * colour has still told the operator their install is broken.
 */
import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { getFunctionName, type FunctionReference } from 'convex/server';
import { api } from '@owlat/api';
import IndependenceTrendChart from '../IndependenceTrendChart.vue';
import RampCellsGrid from '../RampCellsGrid.vue';
import RampCellControls from '../RampCellControls.vue';
import RampDecreaseNotices from '../RampDecreaseNotices.vue';
import RampDecisionTimeline from '../RampDecisionTimeline.vue';
import RampPresetPicker from '../RampPresetPicker.vue';
import ControlsPage from '~/pages/dashboard/delivery/controls.vue';
import QueryBoundary from '~/components/ui/QueryBoundary.vue';
import { rampRefusalSentence, type RampControlRefusal } from '~/utils/deliverabilityRamp';
import MeasurementGateList from '../MeasurementGateList.vue';
import { improvementCopy, confidenceLabel } from '~/utils/deliverabilityMeasurement';
import { holdingGate } from './measurementFixtures';
import { cellControl, controlsView, NOW } from './rampFixtures';

const ALARM = /text-error|bg-error|setup incomplete|action required|something went wrong/i;

describe('calm states', () => {
	it('renders a zero-volume, never-ramped cell as neutral with no warning tone', () => {
		const wrapper = mount(RampCellsGrid, {
			props: {
				cells: [cellControl({ isRampManaged: false, ownShare: 0, lastDecision: null })],
				selectedCellKey: null,
				labelledBy: 'grid',
			},
		});
		const state = wrapper.find('[data-testid="ramp-cell-state"]');
		expect(state.attributes('data-state')).toBe('unmanaged');
		expect(state.text()).toBe('Not on the ramp yet');
		expect(wrapper.find('[data-testid="ramp-cell-constraint"]').text()).toContain(
			'not being ramped yet'
		);
		expect(wrapper.html()).not.toMatch(ALARM);
		wrapper.unmount();
	});

	it('offers an improvement rather than a nag on a cell the ramp does not manage', () => {
		const wrapper = mount(RampCellControls, {
			props: { cell: cellControl({ isRampManaged: false }) },
		});
		const note = wrapper.find('[data-testid="ramp-controls-unmanaged"]').text();
		expect(note).toContain('joins on its own');
		expect(note).toContain('no setup needed');
		// Controls exist but are inert — no dead-end, no error.
		expect(wrapper.find('[data-testid="ramp-control-pause"]').attributes('disabled')).toBeDefined();
		expect(wrapper.html()).not.toMatch(ALARM);
		wrapper.unmount();
	});

	it('renders insufficient_data as a distance from a floor, in a neutral tone', () => {
		const wrapper = mount(MeasurementGateList, {
			props: { gates: [holdingGate()], failedGate: null, requiresCorroboration: false },
		});
		expect(wrapper.text()).toContain('Not enough data yet');
		expect(wrapper.html()).not.toMatch(ALARM);
		wrapper.unmount();
	});

	it('names what would improve a low-confidence measurement as an invitation', () => {
		expect(confidenceLabel('low')).toBe('Measurement confidence: low');
		expect(improvementCopy('connect_reference_transport')).toContain('Connect a relay');
		expect(improvementCopy('add_seed_mailboxes')).toContain('Add seed mailboxes');
		expect(improvementCopy('send_more_volume')).toContain('Send more');
		for (const improvement of [
			'connect_reference_transport',
			'add_seed_mailboxes',
			'send_more_volume',
		] as const) {
			expect(improvementCopy(improvement)).not.toMatch(/must|required|incomplete/i);
		}
	});

	it('draws no chart, and no alarm, with nothing or one day of history', () => {
		const empty = mount(IndependenceTrendChart, {
			props: { points: [], hasReference: false, labelledBy: 'chart' },
		});
		expect(empty.find('[data-testid="independence-chart-empty"]').text()).toContain(
			'Nothing has been sent yet'
		);
		expect(empty.html()).not.toMatch(ALARM);
		empty.unmount();

		const single = mount(IndependenceTrendChart, {
			props: {
				points: [{ day: NOW, own: 10, reference: 0 }],
				hasReference: false,
				labelledBy: 'chart',
			},
		});
		expect(single.find('[data-testid="independence-chart-empty"]').text()).toContain(
			'One day of history'
		);
		single.unmount();
	});

	it('collapses the chart to one band with no relay — a supported configuration', () => {
		const points = Array.from({ length: 5 }, (_, index) => ({
			day: NOW + index * 86_400_000,
			own: 100 + index,
			reference: 0,
		}));
		const wrapper = mount(IndependenceTrendChart, {
			props: { points, hasReference: false, labelledBy: 'chart' },
		});
		expect(wrapper.find('[data-testid="own-band"]').exists()).toBe(true);
		expect(wrapper.find('[data-testid="reference-band"]').exists()).toBe(false);
		expect(wrapper.text()).not.toContain('Relay');
		wrapper.unmount();
	});

	it('treats "nothing has happened yet" as normal in both history surfaces', () => {
		const notices = mount(RampDecreaseNotices, { props: { notices: [], labelledBy: 'n' } });
		expect(notices.html()).not.toMatch(ALARM);
		notices.unmount();

		const timeline = mount(RampDecisionTimeline, { props: { decisions: [], labelledBy: 'h' } });
		expect(timeline.html()).not.toMatch(ALARM);
		timeline.unmount();
	});
});

/**
 * A REFUSAL IS AN EXPLANATION, NOT A FAILURE.
 *
 * The control mutations answer `{applied: false, refusal}` rather than throwing,
 * so nothing in the UI's error machinery ever sees them. If the page discards
 * that answer, the operator clicks, nothing moves, and no sentence appears —
 * which is exactly how a working rule gets reported as a bug.
 */
describe('control refusals', () => {
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

	function stubPage(refusal: RampControlRefusal): { run: ReturnType<typeof vi.fn> } {
		const run = vi.fn().mockResolvedValue({ applied: false, refusal });
		vi.stubGlobal('useHead', vi.fn());
		vi.stubGlobal('definePageMeta', vi.fn());
		vi.stubGlobal('useBackendOperation', () => ({ run, isLoading: ref(false) }));
		// The controls are admin-only; a refusal is what an ADMIN meets.
		vi.stubGlobal('usePermissions', () => ({
			canManageOrganization: ref(true),
			showAdminGate: ref(false),
		}));
		const answers = new Map<string, unknown>([
			[getFunctionName(api.delivery.rampControlQueries.getRampControls), controlsView()],
			[getFunctionName(api.delivery.rampControlQueries.listRampAdminNotices), []],
		]);
		vi.stubGlobal('useOrganizationQuery', (query: FunctionReference<'query'>) => ({
			data: ref(answers.get(getFunctionName(query))),
			isLoading: ref(false),
			error: ref(null),
			refetch: vi.fn(),
		}));
		return { run };
	}

	it.each<[RampControlRefusal, RegExp]>([
		['controller_paused', /globally paused/i],
		['hard_stop_active', /safety hold/i],
		['cell_not_ramp_managed', /not on the ramp yet/i],
	])('explains the %s refusal calmly instead of showing nothing', async (refusal, sentence) => {
		stubPage(refusal);
		const wrapper = mount(ControlsPage, { global: globalOptions });
		await wrapper.find('[data-testid="ramp-select-campaign:gmail"]').trigger('click');
		await wrapper.vm.$nextTick();
		await wrapper.find('[data-testid="ramp-control-pause"]').trigger('click');
		await new Promise((resolve) => setTimeout(resolve, 0));
		await wrapper.vm.$nextTick();
		const note = wrapper.find('[data-testid="ramp-control-refusal"]');
		expect(note.exists()).toBe(true);
		expect(note.text()).toMatch(sentence);
		expect(note.html()).not.toMatch(ALARM);
		wrapper.unmount();
	});

	/** Every arm has a sentence, and none of them reads as a fault. */
	it('gives every refusal arm a calm sentence that ends in something to do', () => {
		const arms: readonly RampControlRefusal[] = [
			'controller_paused',
			'hard_stop_active',
			'cell_not_ramp_managed',
		];
		for (const arm of arms) {
			const sentence = rampRefusalSentence(arm);
			expect(sentence.length).toBeGreaterThan(20);
			expect(sentence).not.toMatch(ALARM);
			expect(sentence).not.toMatch(/error|failed|invalid/i);
		}
	});
});

/**
 * SAY THE QUIET PART (plan D14). A standalone deployment can still pick a faster
 * pace — it is their deployment — but it must be told what that pace is running
 * on, in the same calm register as every other state here.
 */
describe('standalone preset trade-off', () => {
	it('names what the faster paces lack when there is no relay', () => {
		const wrapper = mount(RampPresetPicker, {
			props: {
				stream: 'campaign',
				preset: null,
				defaultPreset: 'conservative',
				hasReferenceArm: false,
			},
		});
		const note = wrapper.find('[data-testid="ramp-preset-standalone-note-aggressive"]');
		expect(note.exists()).toBe(true);
		expect(note.text()).toMatch(/weaker signal/i);
		expect(wrapper.find('[data-testid="ramp-preset-standalone-note-conservative"]').exists()).toBe(
			false
		);
		expect(wrapper.html()).not.toMatch(ALARM);
		wrapper.unmount();
	});

	/**
	 * THE RADIO IS A CLAIM ABOUT WHAT IS SAVED, and the browser moves it before
	 * anything is. A `setStreamPreset` that never landed used to leave the group
	 * sitting on the unsaved option — the operator reads the pace they picked, the
	 * controller runs the pace they had, and nothing on screen says so.
	 */
	it('puts the radio back on the stored pace when the write does not land', async () => {
		const wrapper = mount(RampPresetPicker, {
			props: {
				stream: 'campaign',
				preset: null,
				defaultPreset: 'balanced',
				hasReferenceArm: true,
			},
		});
		const aggressive = wrapper.find<HTMLInputElement>(
			'[data-testid="ramp-preset-option-aggressive"]'
		);
		await aggressive.setValue();

		expect(wrapper.emitted('change')).toEqual([['aggressive']]);
		// The prop never changed — the mutation was refused, or it failed.
		expect(aggressive.element.checked).toBe(false);
		expect(
			wrapper.find<HTMLInputElement>('[data-testid="ramp-preset-default"]').element.checked
		).toBe(true);
		wrapper.unmount();
	});

	it('moves once the stored pace has actually changed', async () => {
		const wrapper = mount(RampPresetPicker, {
			props: {
				stream: 'campaign',
				preset: null,
				defaultPreset: 'balanced',
				hasReferenceArm: true,
			},
		});
		await wrapper.find('[data-testid="ramp-preset-option-aggressive"]').setValue();
		await wrapper.setProps({ preset: 'aggressive' });

		expect(
			wrapper.find<HTMLInputElement>('[data-testid="ramp-preset-option-aggressive"]').element
				.checked
		).toBe(true);
		expect(
			wrapper.find<HTMLInputElement>('[data-testid="ramp-preset-default"]').element.checked
		).toBe(false);
		wrapper.unmount();
	});

	it('says nothing extra when a relay is connected', () => {
		const wrapper = mount(RampPresetPicker, {
			props: { stream: 'campaign', preset: null, defaultPreset: 'balanced', hasReferenceArm: true },
		});
		expect(wrapper.find('[data-testid="ramp-preset-standalone-note-aggressive"]').exists()).toBe(
			false
		);
		wrapper.unmount();
	});
});
