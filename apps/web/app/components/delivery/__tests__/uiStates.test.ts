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
import { defineComponent, ref, type Ref } from 'vue';
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
import {
	rampRefusalSentence,
	type RampCellControl,
	type RampControlRefusal,
	type RampControls,
} from '~/utils/deliverabilityRamp';
import MeasurementGateList from '../MeasurementGateList.vue';
import { improvementCopy, confidenceLabel } from '~/utils/deliverabilityMeasurement';
import { holdingGate } from './measurementFixtures';
import { adminNotice, cellControl, controlsView, NOW } from './rampFixtures';

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

	/**
	 * AN INVITATION, NOT A NAG — and not a false promise either. Nothing puts a
	 * cell on the ramp on its own, so the copy that used to say it "joins on its
	 * own, no setup needed" described a thing that never happens; the honest calm
	 * state is the sentence plus the affordance that makes it true.
	 */
	it('offers the way ONTO the ramp on a cell the ramp does not manage', () => {
		const wrapper = mount(RampCellControls, {
			props: { cell: cellControl({ isRampManaged: false }), hasRelayConfigured: true },
		});
		const note = wrapper.find('[data-testid="ramp-controls-unmanaged"]').text();
		expect(note).toContain('not on the ramp yet');
		const enroll = wrapper.find('[data-testid="ramp-control-enroll"]');
		expect(enroll.exists()).toBe(true);
		expect(enroll.attributes('disabled')).toBeUndefined();
		enroll.trigger('click');
		expect(wrapper.emitted('enroll')).toHaveLength(1);
		// The other controls exist but are inert — no dead-end, no error.
		expect(wrapper.find('[data-testid="ramp-control-pause"]').attributes('disabled')).toBeDefined();
		expect(wrapper.html()).not.toMatch(ALARM);
		wrapper.unmount();
	});

	/**
	 * A RESET ONLY GOES DOWN. Offering a rung above the cell's ceiling as a reset
	 * would present the ladder's most expensive move as its cheapest, and the
	 * server would refuse it — a button that cannot work is a dead end.
	 */
	it('offers only the rungs at or below the cell’s ceiling as a reset', () => {
		const wrapper = mount(RampCellControls, {
			props: { cell: cellControl({ phaseCeiling: 0.5 }), hasRelayConfigured: true },
		});
		expect(wrapper.find('[data-testid="ramp-control-phase-0.25"]').attributes('disabled')).toBe(
			undefined
		);
		expect(wrapper.find('[data-testid="ramp-control-phase-0.5"]').attributes('disabled')).toBe(
			undefined
		);
		expect(
			wrapper.find('[data-testid="ramp-control-phase-0.8"]').attributes('disabled')
		).toBeDefined();
		expect(
			wrapper.find('[data-testid="ramp-control-phase-1"]').attributes('disabled')
		).toBeDefined();
		wrapper.find('[data-testid="ramp-control-promote-phase"]').trigger('click');
		expect(wrapper.emitted('promotePhase')).toHaveLength(1);
		wrapper.unmount();
	});

	/**
	 * A STORED RUNG IS AN UNCONSTRAINED NUMBER, and the server snaps it DOWN onto
	 * the ladder before deciding anything. A raw reading here disagreed with that
	 * in both directions: a row below the ladder disabled every rung button while
	 * the server accepted the reset, and a row above it left "Promote a phase"
	 * live on a cell the server answers as already at the top.
	 */
	it('reads a rung that is not on the ladder the way the server does', () => {
		const below = mount(RampCellControls, {
			props: { cell: cellControl({ phaseCeiling: 0.1 }), hasRelayConfigured: true },
		});
		// The screen that owns the move has to be able to make it.
		expect(below.find('[data-testid="ramp-control-phase-0.25"]').attributes('disabled')).toBe(
			undefined
		);
		expect(
			below.find('[data-testid="ramp-control-phase-0.5"]').attributes('disabled')
		).toBeDefined();
		below.unmount();

		const above = mount(RampCellControls, {
			props: { cell: cellControl({ phaseCeiling: 1.2 }), hasRelayConfigured: true },
		});
		expect(
			above.find('[data-testid="ramp-control-promote-phase"]').attributes('disabled')
		).toBeDefined();
		expect(above.find('[data-testid="ramp-control-phase-1"]').attributes('disabled')).toBe(
			undefined
		);
		above.unmount();
	});

	/**
	 * A DORMANT RUNG SAID PLAINLY (plan D3, D14). With no relay the phase ladder
	 * bounds nothing — the server records the rung and holds the share — so copy
	 * calling it the cell's governing ceiling describes a 75% cut this deployment
	 * cannot make and would not want.
	 */
	it('says the rung is recorded, not applied, when there is no relay', () => {
		const standalone = mount(RampCellControls, {
			props: { cell: cellControl({ phaseCeiling: 0.25, ownShare: 1 }), hasRelayConfigured: false },
		});
		const note = standalone.find('[data-testid="ramp-reset-note"]').text();
		expect(note).toContain('share stays where it is');
		expect(note).not.toMatch(/brings the share back/i);
		expect(standalone.html()).not.toMatch(ALARM);
		standalone.unmount();

		const withRelay = mount(RampCellControls, {
			props: { cell: cellControl({ phaseCeiling: 0.25, ownShare: 1 }), hasRelayConfigured: true },
		});
		expect(withRelay.find('[data-testid="ramp-reset-note"]').text()).toContain(
			'brings the share back'
		);
		withRelay.unmount();
	});

	/**
	 * THE ARM SHUFFLE IS AN ESP-PATH CLAIM (plan D7, D14). A pace-path cell has one
	 * arm — no `adaptive_mix` route builds a mix at all — so a promotion re-shuffles
	 * nobody there, and the state is reachable from the first minute: a standalone
	 * enrolment opens at full share on the 25% rung, with the button live.
	 */
	it('does not promise an arm shuffle on a promotion with no relay', () => {
		const standalone = mount(RampCellControls, {
			props: { cell: cellControl({ phaseCeiling: 0.25, ownShare: 1 }), hasRelayConfigured: false },
		});
		const note = standalone.find('[data-testid="ramp-promote-note"]').text();
		expect(note).toContain('raises the ceiling one rung');
		expect(note).not.toMatch(/which arm/i);
		expect(note).toMatch(/no second arm/i);
		// The evidence half of the promise holds on both paths.
		expect(note).toMatch(/still outstanding/i);
		expect(standalone.html()).not.toMatch(ALARM);
		standalone.unmount();

		const withRelay = mount(RampCellControls, {
			props: { cell: cellControl({ phaseCeiling: 0.25, ownShare: 1 }), hasRelayConfigured: true },
		});
		expect(withRelay.find('[data-testid="ramp-promote-note"]').text()).toMatch(
			/re-shuffles which arm every recipient/i
		);
		withRelay.unmount();
	});

	/**
	 * A BUTTON THAT CANNOT WORK IS A DEAD END. `promoteCellPhase` answers a cell
	 * already on the top rung with `{applied: false}` and NO refusal, so a live
	 * button there fires a mutation and nothing appears at all.
	 */
	it('offers no promotion on a cell already at the top rung', () => {
		const wrapper = mount(RampCellControls, {
			props: { cell: cellControl({ phaseCeiling: 1 }), hasRelayConfigured: true },
		});
		expect(
			wrapper.find('[data-testid="ramp-control-promote-phase"]').attributes('disabled')
		).toBeDefined();
		// And it says why, rather than leaving a greyed-out button unexplained.
		expect(wrapper.find('[data-testid="ramp-promote-note"]').text()).toContain('top phase rung');
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
 * THE TWO HISTORY SURFACES SPEAK THE SCREENS' VOCABULARY.
 *
 * A retreat notice is read by someone deciding whether to act, so it may not be
 * the only place on the surface that names a cell by its stored key.
 */
describe('the retreat history', () => {
	it('names the cell the way every other surface does', () => {
		const wrapper = mount(RampDecreaseNotices, {
			props: { notices: [adminNotice({ cellKey: 'campaign:gmail' })], labelledBy: 'n' },
		});
		expect(wrapper.find('[data-testid="ramp-notice-cell"]').text()).toBe('Campaign → Gmail');
		wrapper.unmount();
	});

	it('falls back to the stored key when it cannot be parsed', () => {
		// Ninety days of history outlives an axis: a row written before a stream was
		// retired must stay readable rather than render as nothing.
		const wrapper = mount(RampDecreaseNotices, {
			props: { notices: [adminNotice({ cellKey: 'newsletter:gmail' })], labelledBy: 'n' },
		});
		expect(wrapper.find('[data-testid="ramp-notice-cell"]').text()).toBe('newsletter:gmail');
		wrapper.unmount();
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

	function stubPage(
		result: unknown,
		cells: readonly RampCellControl[] = [cellControl()],
		view: Partial<RampControls> = {}
	): { run: ReturnType<typeof vi.fn> } {
		const run = vi.fn().mockResolvedValue(result);
		vi.stubGlobal('useHead', vi.fn());
		vi.stubGlobal('definePageMeta', vi.fn());
		vi.stubGlobal('useBackendOperation', () => ({ run, isLoading: ref(false) }));
		// The controls are admin-only; a refusal is what an ADMIN meets.
		vi.stubGlobal('usePermissions', () => ({
			canManageOrganization: ref(true),
			showAdminGate: ref(false),
		}));
		const answers = new Map<string, unknown>([
			[
				getFunctionName(api.delivery.rampControlQueries.getRampControls),
				controlsView({ cells, ...view }),
			],
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
		['cell_already_ramp_managed', /already on the ramp/i],
		['phase_increase_requires_promotion', /only ever rises through a promotion/i],
		['promotion_evidence_outstanding', /evidence for the next phase/i],
	])('explains the %s refusal calmly instead of showing nothing', async (refusal, sentence) => {
		stubPage({ applied: false, refusal });
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

	/**
	 * ONLY THE PAGE KNOWS WHETHER THERE IS A RELAY, so only the page can pin it.
	 * The reset note has two branches, but the fact that chooses between them
	 * reaches the component through one binding on this screen; with the branches
	 * pinned by direct mounts alone, dropping that binding leaves every test green
	 * and puts "brings the share back" — a 75% cut a standalone deployment cannot
	 * make — in front of the operator who must not read it.
	 *
	 * AND THE BINDING HAS TO BE THE FACT THE SERVER CUTS ON. The two-relay row is
	 * the one that separates them: `referenceTransportId` is null there because no
	 * SINGLE arm can be named, while `resetCellPhase` cuts the share all the same.
	 */
	it.each<[string, Partial<RampControls>, RegExp, RegExp]>([
		[
			'no relay',
			{ referenceTransportId: null, isRelayConfigured: false },
			/share stays where it is/i,
			/brings the share back/i,
		],
		[
			'one relay',
			{ referenceTransportId: 'ses', isRelayConfigured: true },
			/brings the share back/i,
			/share stays where it is/i,
		],
		[
			'two relays',
			{ referenceTransportId: null, isRelayConfigured: true },
			/brings the share back/i,
			/share stays where it is/i,
		],
	])(
		'tells a deployment with %s what a reset does to its share',
		async (_name, view, expected, refuted) => {
			stubPage({ applied: true }, [cellControl()], view);
			const wrapper = mount(ControlsPage, { global: globalOptions });
			await wrapper.find('[data-testid="ramp-select-campaign:gmail"]').trigger('click');
			await wrapper.vm.$nextTick();
			const note = wrapper.find('[data-testid="ramp-reset-note"]');
			expect(note.exists()).toBe(true);
			expect(note.text()).toMatch(expected);
			expect(note.text()).not.toMatch(refuted);
			expect(note.html()).not.toMatch(ALARM);
			wrapper.unmount();
		}
	);

	/**
	 * THE PROMOTION REFUSAL CARRIES A LIST, and a list the page drops is a "not
	 * yet" with nothing to act on — the exact shape D12/D14 exist to prevent.
	 */
	it('lists what the next phase rung is still waiting on', async () => {
		stubPage({
			applied: false,
			refusal: 'promotion_evidence_outstanding',
			phaseCeiling: 0.5,
			outstanding: ['dnsbl_clean_streak', 'seed_probe_pass_recent'],
		});
		const wrapper = mount(ControlsPage, { global: globalOptions });
		await wrapper.find('[data-testid="ramp-select-campaign:gmail"]').trigger('click');
		await wrapper.vm.$nextTick();
		await wrapper.find('[data-testid="ramp-control-promote-phase"]').trigger('click');
		await new Promise((resolve) => setTimeout(resolve, 0));
		await wrapper.vm.$nextTick();
		const list = wrapper.find('[data-testid="ramp-promotion-outstanding"]');
		expect(list.exists()).toBe(true);
		expect(list.text()).toContain('blocklist-clean days');
		expect(list.text()).toContain('seed-mailbox placement probe');
		expect(list.html()).not.toMatch(ALARM);
		wrapper.unmount();
	});

	/**
	 * The page owns the write, so the button has to reach the mutation — and the
	 * ANSWER has to land on the screen. The setup fork is resolved server-side and
	 * never chosen by the operator, so which of the two ramps the cell got is
	 * knowable from this sentence and nowhere else.
	 */
	it('puts an unmanaged cell on the ramp and says which ramp it got', async () => {
		const { run } = stubPage(
			{ enrolled: true, share: 0.02, path: 'esp_relay', isShareRouted: true },
			[cellControl({ isRampManaged: false })]
		);
		const wrapper = mount(ControlsPage, { global: globalOptions });
		await wrapper.find('[data-testid="ramp-select-campaign:gmail"]').trigger('click');
		await wrapper.vm.$nextTick();
		await wrapper.find('[data-testid="ramp-control-enroll"]').trigger('click');
		await new Promise((resolve) => setTimeout(resolve, 0));
		await wrapper.vm.$nextTick();
		expect(run).toHaveBeenCalledWith({ stream: 'campaign', destinationProvider: 'gmail' });
		expect(wrapper.find('[data-testid="ramp-control-refusal"]').exists()).toBe(false);
		const outcome = wrapper.find('[data-testid="ramp-control-outcome"]');
		expect(outcome.text()).toContain('2%');
		expect(outcome.text()).toContain('relay carries the rest');
		expect(outcome.html()).not.toMatch(ALARM);
		wrapper.unmount();
	});

	/**
	 * AND A SHARE NOTHING ROUTES ON YET IS SAID PLAINLY. The router splits by the
	 * cell's share only under the controller-owned `adaptive_mix` strategy, so a
	 * cell enrolled on a shipped `priority_failover` stream gets a live number and
	 * no traffic move at all. "Your relay carries the rest" there describes mail
	 * that never went anywhere — and the 2% beside it then reads as broken rather
	 * than as dormant.
	 */
	it('does not promise a split the stream’s route cannot make', async () => {
		stubPage({ enrolled: true, share: 0.02, path: 'esp_relay', isShareRouted: false }, [
			cellControl({ isRampManaged: false }),
		]);
		const wrapper = mount(ControlsPage, { global: globalOptions });
		await wrapper.find('[data-testid="ramp-select-campaign:gmail"]').trigger('click');
		await wrapper.vm.$nextTick();
		await wrapper.find('[data-testid="ramp-control-enroll"]').trigger('click');
		await new Promise((resolve) => setTimeout(resolve, 0));
		await wrapper.vm.$nextTick();
		const outcome = wrapper.find('[data-testid="ramp-control-outcome"]');
		expect(outcome.text()).toContain('2%');
		expect(outcome.text()).toMatch(/does not split by share/i);
		expect(outcome.text()).not.toMatch(/relay carries the rest/i);
		expect(outcome.html()).not.toMatch(ALARM);
		wrapper.unmount();
	});

	/** The own-server enrolment is a different ramp, and says so. */
	it('names the standalone ramp when there is no relay to move away from', async () => {
		stubPage({ enrolled: true, share: 1, path: 'own_server', isShareRouted: false }, [
			cellControl({ isRampManaged: false }),
		]);
		const wrapper = mount(ControlsPage, { global: globalOptions });
		await wrapper.find('[data-testid="ramp-select-campaign:gmail"]').trigger('click');
		await wrapper.vm.$nextTick();
		await wrapper.find('[data-testid="ramp-control-enroll"]').trigger('click');
		await new Promise((resolve) => setTimeout(resolve, 0));
		await wrapper.vm.$nextTick();
		const outcome = wrapper.find('[data-testid="ramp-control-outcome"]');
		expect(outcome.text()).toContain('warm-up pace');
		expect(outcome.html()).not.toMatch(ALARM);
		wrapper.unmount();
	});

	/**
	 * THE TOP RUNG IS AN ANSWER, NOT A REFUSAL, and the page has to render it: the
	 * server can answer this even when the screen's copy of the rung is behind the
	 * row's, and a click that produces nothing reads as a broken button.
	 */
	it('says there is nothing to promote when the server answers at the top rung', async () => {
		stubPage({ applied: false, phaseCeiling: 1 }, [cellControl({ phaseCeiling: 0.8 })]);
		const wrapper = mount(ControlsPage, { global: globalOptions });
		await wrapper.find('[data-testid="ramp-select-campaign:gmail"]').trigger('click');
		await wrapper.vm.$nextTick();
		await wrapper.find('[data-testid="ramp-control-promote-phase"]').trigger('click');
		await new Promise((resolve) => setTimeout(resolve, 0));
		await wrapper.vm.$nextTick();
		expect(wrapper.find('[data-testid="ramp-control-refusal"]').exists()).toBe(false);
		const outcome = wrapper.find('[data-testid="ramp-control-outcome"]');
		expect(outcome.text()).toContain('nothing left to promote');
		expect(outcome.html()).not.toMatch(ALARM);
		wrapper.unmount();
	});

	/**
	 * AND WHAT THE NEW RUNG DOES IS THE PAGE'S FACT TO SUPPLY. The ladder bounds
	 * the SHARE dial, so on a standalone cell the ceiling is dropped by
	 * `phaseLadderBounds` and nothing climbs toward it — the promoted cell already
	 * sends the whole cell from its own server. Only this page knows which path the
	 * deployment is on, so a sentence that forgets to ask promises a climb that
	 * cannot happen.
	 */
	it.each<[string, Partial<RampControls>, RegExp, RegExp]>([
		[
			'no relay',
			{ referenceTransportId: null, isRelayConfigured: false },
			/nothing holding it below the rung/i,
			/climbs/i,
		],
		['a relay', { isRelayConfigured: true }, /climbs toward the new ceiling/i, /no relay/i],
	])('says what a promotion does to the share with %s', async (_name, view, expected, refuted) => {
		stubPage({ applied: true, phaseCeiling: 0.5 }, [cellControl({ phaseCeiling: 0.25 })], view);
		const wrapper = mount(ControlsPage, { global: globalOptions });
		await wrapper.find('[data-testid="ramp-select-campaign:gmail"]').trigger('click');
		await wrapper.vm.$nextTick();
		await wrapper.find('[data-testid="ramp-control-promote-phase"]').trigger('click');
		await new Promise((resolve) => setTimeout(resolve, 0));
		await wrapper.vm.$nextTick();
		const outcome = wrapper.find('[data-testid="ramp-control-outcome"]');
		expect(outcome.text()).toContain('50% phase');
		expect(outcome.text()).toMatch(expected);
		expect(outcome.text()).not.toMatch(refuted);
		expect(outcome.html()).not.toMatch(ALARM);
		wrapper.unmount();
	});

	/**
	 * Every arm has a sentence, and none of them reads as a fault.
	 *
	 * KEYED BY THE UNION rather than listed: a hand-written array silently stops
	 * covering an arm the server adds, which is how a refusal ships with no
	 * sentence and an operator watches a click do nothing.
	 */
	it('gives every refusal arm a calm sentence that ends in something to do', () => {
		const armSet: Record<RampControlRefusal, true> = {
			controller_paused: true,
			hard_stop_active: true,
			cell_not_ramp_managed: true,
			cell_already_ramp_managed: true,
			phase_increase_requires_promotion: true,
			promotion_evidence_outstanding: true,
		};
		const arms = Object.keys(armSet) as RampControlRefusal[];
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

	/**
	 * A pace whose write is IN FLIGHT is not yet a pace nobody is on. The parent
	 * marks itself busy inside the change handler (`useBackendOperation.run`), so
	 * the picker is mounted under one here rather than driven by `setProps` a tick
	 * late — the ordering is the whole point of the test.
	 */
	function mountUnderParent(): { wrapper: ReturnType<typeof mount>; busy: Ref<boolean> } {
		const busy = ref(false);
		const Parent = defineComponent({
			components: { RampPresetPicker },
			setup: () => ({ busy, onChange: () => void (busy.value = true) }),
			template: `<RampPresetPicker stream="campaign" :preset="null" default-preset="balanced"
				:has-reference-arm="true" :busy="busy" @change="onChange" />`,
		});
		return { wrapper: mount(Parent), busy };
	}

	it('keeps the clicked pace visible while the write is in flight', async () => {
		// Snapping the radio back the instant it is clicked greys out the option
		// the operator just chose, and the click reads as one that never landed.
		const { wrapper, busy } = mountUnderParent();
		await wrapper.find('[data-testid="ramp-preset-option-aggressive"]').setValue();

		expect(busy.value).toBe(true);
		expect(
			wrapper.find<HTMLInputElement>('[data-testid="ramp-preset-option-aggressive"]').element
				.checked
		).toBe(true);
		wrapper.unmount();
	});

	it('corrects the radio once a refused write settles', async () => {
		const { wrapper, busy } = mountUnderParent();
		await wrapper.find('[data-testid="ramp-preset-option-aggressive"]').setValue();

		// The write answered and `preset` never moved: refused, or it failed.
		busy.value = false;
		await nextTick();

		expect(
			wrapper.find<HTMLInputElement>('[data-testid="ramp-preset-option-aggressive"]').element
				.checked
		).toBe(false);
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
