// @vitest-environment happy-dom
/**
 * The measurement PAGE, mounted.
 *
 * The card's own accessibility pass covers the card; this covers the page that
 * frames it — the single `h1` the cards' `h3`s descend from, the loading state's
 * announceable name, the non-alarming error copy, and D14's headline switch
 * between "Sending independence" and "Warm-up autopilot".
 *
 * Mounted rather than read as source text: a heading inside an HTML comment, or
 * a prop with no runtime effect, passes a substring check and fails a user.
 */
import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref, type Ref } from 'vue';
import MeasurementPage from '../advanced/measurement.vue';
import { armSummary, cellView } from '~/components/delivery/__tests__/measurementFixtures';
import type { DeliverabilityDashboard } from '~/utils/deliverabilityMeasurement';
import MeasurementCellCard from '~/components/delivery/MeasurementCellCard.vue';
import MeasurementGateList from '~/components/delivery/MeasurementGateList.vue';
import QueryBoundary from '~/components/ui/QueryBoundary.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

const WINDOW_END = Date.UTC(2026, 6, 16);
const WINDOW_START = WINDOW_END - 7 * 24 * 60 * 60 * 1000;

function dashboard(overrides: Partial<DeliverabilityDashboard> = {}): DeliverabilityDashboard {
	return {
		generatedAt: WINDOW_END,
		windowStart: WINDOW_START,
		windowEnd: WINDOW_END,
		// The deciding span is the controller's, and it is a fixture value here for
		// the same reason the window is: the page renders both, and only the page
		// knows they are different spans (#510).
		decisionWindowStart: WINDOW_END - 24 * 60 * 60 * 1000,
		decisionWindowEnd: WINDOW_END,
		referenceTransportId: 'ses',
		isRelayConfigured: true,
		hasSeedCoverage: false,
		cells: [cellView()],
		...overrides,
	};
}

const data: Ref<DeliverabilityDashboard | undefined> = ref(undefined);
const isLoading = ref(false);
const error: Ref<Error | null> = ref(null);

beforeEach(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
	data.value = dashboard();
	isLoading.value = false;
	error.value = null;
	vi.stubGlobal('useHead', vi.fn());
	vi.stubGlobal('definePageMeta', vi.fn());
	vi.stubGlobal('useOrganizationQuery', () => ({ data, isLoading, error, refetch: vi.fn() }));
});

const passthroughCard = { template: '<div><slot /></div>' };

function mountPage() {
	return mount(MeasurementPage, {
		global: {
			plugins: [createTestI18n()],
			stubs: {
				UiIconBox: true,
				Icon: true,
				UiSpinner: true,
				UiEmptyState: true,
				UiCard: passthroughCard,
				UiErrorAlert: {
					props: ['title', 'message'],
					template: '<div>{{ title }} {{ message }}</div>',
				},
				UiButton: { template: '<button><slot /></button>' },
			},
			components: {
				// The REAL boundary: its loading/error branching is what this suite
				// asserts, so stubbing it would assert nothing.
				UiQueryBoundary: QueryBoundary,
				DeliveryMeasurementCellCard: MeasurementCellCard,
				DeliveryMeasurementGateList: MeasurementGateList,
			},
		},
	});
}

describe('measurement page — headings and landmarks', () => {
	it('owns exactly one h1 and lets the cards descend from it without skipping', () => {
		const wrapper = mountPage();
		const h1s = wrapper.findAll('h1');
		expect(h1s).toHaveLength(1);
		expect(h1s[0]?.text()).toBe('Sending independence');
		// No h2 in between is fine only because the cards are h3 sections labelled
		// by their own heading; what must not happen is a card outranking the page.
		expect(wrapper.findAll('h3').length).toBeGreaterThan(0);
		expect(wrapper.findAll('h4').length).toBeGreaterThan(0);
		const section = wrapper.find('section');
		const labelledBy = section.attributes('aria-labelledby');
		expect(labelledBy).toBeTruthy();
		expect(wrapper.find(`#${labelledBy}`).element.tagName).toBe('H3');
		wrapper.unmount();
	});

	it('renders the window it summarizes', () => {
		const wrapper = mountPage();
		expect(wrapper.find('[data-testid="measurement-window"]').text().length).toBeGreaterThan(0);
		wrapper.unmount();
	});

	/**
	 * TWO SPANS, TWO LABELS (#510). The cards count over the reported window and
	 * their checks were decided over the controller's own, so a heading that named
	 * only the first would put a week's dates over verdicts reached in a day.
	 */
	it('names the deciding span beside the window it summarizes', () => {
		const wrapper = mountPage();
		const reported = wrapper.find('[data-testid="measurement-window"]').text();
		const deciding = wrapper.find('[data-testid="measurement-decision-window"]').text();
		expect(deciding).toBe('the last 24 hours');
		expect(deciding).not.toBe(reported);
		// And it reaches every card, so no gate list is left unlabelled.
		expect(wrapper.findAll('[data-testid="measurement-gate-window"]').length).toBe(
			wrapper.findAll('[data-testid="measurement-gate-list"]').length
		);
		wrapper.unmount();
	});

	it('offers no controls — the page is read-only until P3-6', () => {
		const wrapper = mountPage();
		expect(wrapper.findAll('button')).toHaveLength(0);
		expect(wrapper.findAll('input')).toHaveLength(0);
		expect(wrapper.html()).not.toMatch(/tabindex="[1-9]/);
		wrapper.unmount();
	});
});

describe('measurement page — states', () => {
	it('announces the loading state instead of labelling a bare div', () => {
		isLoading.value = true;
		data.value = undefined;
		const wrapper = mountPage();
		const status = wrapper.find('[role="status"]');
		expect(status.exists()).toBe(true);
		expect(status.attributes('aria-live')).toBe('polite');
		expect(status.attributes('aria-label')).toBe('Loading delivery measurements');
		wrapper.unmount();
	});

	it('reassures rather than alarms when the read fails', () => {
		error.value = new Error('boom');
		data.value = undefined;
		const wrapper = mountPage();
		expect(wrapper.text()).toContain('Couldn’t load delivery measurements');
		expect(wrapper.text()).toContain('Your mail is unaffected');
		wrapper.unmount();
	});

	it('switches to the standalone feature and offers a relay where there is none (D14)', () => {
		data.value = dashboard({
			referenceTransportId: null,
			isRelayConfigured: false,
			cells: [cellView({ reference: null })],
		});
		const wrapper = mountPage();
		expect(wrapper.find('h1').text()).toBe('Warm-up autopilot');
		const note = wrapper.find('[data-testid="measurement-standalone-note"]');
		expect(note.exists()).toBe(true);
		expect(note.text()).toContain('Connecting a relay you already pay for');
		expect(note.text()).toContain('optional');
		// An invitation, never a warning or a "setup incomplete" nag (plan D2).
		expect(note.text()).not.toMatch(/error|incomplete|required|must/i);
		wrapper.unmount();
	});

	it('does not show the standalone note when a reference transport is connected', () => {
		const wrapper = mountPage();
		expect(wrapper.find('[data-testid="measurement-standalone-note"]').exists()).toBe(false);
		wrapper.unmount();
	});

	it('frames a two-relay deployment by its cells, not by the relay it cannot name', () => {
		// TWO RELAY KINDS: there is no single arm to NAME, so the configuration
		// reads `null` while every cell was measured against a relay. Framed by the
		// id, this page told the operator they send entirely from their own server
		// directly above a card carrying a relay column.
		data.value = dashboard({ referenceTransportId: null, cells: [cellView()] });
		const wrapper = mountPage();
		expect(wrapper.find('h1').text()).toBe('Sending independence');
		expect(wrapper.find('[data-testid="measurement-standalone-note"]').exists()).toBe(false);
		expect(wrapper.find('[data-testid="measurement-reference-value"]').exists()).toBe(true);
		wrapper.unmount();
	});

	it('frames a named relay that carried nothing as standalone, without offering it again', () => {
		// The same divergence pointing the other way: a relay is configured, no
		// cell was measured against it, and the gates below graded every cell
		// standalone. The FRAMING has to say what the cards say — and the OFFER
		// must not, because this deployment already pays for the relay it would
		// be asked to connect.
		//
		// The relay carried a day inside the plotted window, which is what makes
		// the closing promise about the cards true here — the card's own quiet
		// relay line renders beside it on the same premise.
		const day = Date.UTC(2026, 6, 14);
		data.value = dashboard({
			referenceTransportId: 'ses',
			isRelayConfigured: true,
			cells: [
				cellView({
					reference: null,
					trend: [{ day, own: armSummary({ sent: 100 }), reference: armSummary({ sent: 40 }) }],
				}),
			],
		});
		const wrapper = mountPage();
		expect(wrapper.find('h1').text()).toBe('Warm-up autopilot');
		const note = wrapper.find('[data-testid="measurement-standalone-note"]');
		expect(note.exists()).toBe(true);
		expect(note.text()).not.toContain('Connecting a relay');
		expect(note.text()).toContain('Amazon SES carried none of this traffic recently');
		expect(note.text()).toContain('The days it did carry are still plotted');
		expect(wrapper.find('[data-testid="measurement-quiet-relay"]').exists()).toBe(true);
		expect(wrapper.find('[data-testid="measurement-reference-value"]').exists()).toBe(false);
		wrapper.unmount();
	});

	/**
	 * THE BANNER MAY NOT POINT AT BARS THAT DO NOT EXIST.
	 *
	 * A configured relay that carried nothing anywhere in the plotted window: a
	 * graduated deployment at full own share, a relay connected today, a relay
	 * enabled only for streams outside this screen. The explanation still holds;
	 * the promise about the cards below does not, and no card makes it either.
	 */
	it('drops the plotted-days promise where no card plots a relay day', () => {
		data.value = dashboard({
			referenceTransportId: 'ses',
			isRelayConfigured: true,
			cells: [
				cellView({
					reference: null,
					trend: [{ day: Date.UTC(2026, 6, 15), own: armSummary({ sent: 120 }), reference: null }],
				}),
			],
		});
		const wrapper = mountPage();
		const note = wrapper.find('[data-testid="measurement-standalone-note"]');
		expect(note.exists()).toBe(true);
		expect(note.text()).toContain('Amazon SES carried none of this traffic recently');
		expect(note.text()).not.toContain('still plotted');
		// The trend renders — the days are there, none of them a relay day — so the
		// missing promise is about the relay's bars, not about an empty chart.
		expect(wrapper.find('[data-testid="measurement-trend"]').exists()).toBe(true);
		expect(wrapper.find('[data-testid="measurement-quiet-relay"]').exists()).toBe(false);
		wrapper.unmount();
	});

	/**
	 * THE BANNER AND THE CARD CANNOT CONTRADICT EACH OTHER.
	 *
	 * One deployment, one screen: a relay that carried this cell earlier in the
	 * window and nothing recently. Keyed to the measurement, the banner offered
	 * "connect a relay you already pay for" three lines above the card's own line
	 * saying that relay carried the cell earlier in this window.
	 */
	it('never offers a relay above a card explaining that relay went quiet', () => {
		const day = Date.UTC(2026, 6, 15);
		data.value = dashboard({
			referenceTransportId: 'ses',
			isRelayConfigured: true,
			cells: [
				cellView({
					reference: null,
					trend: [
						{ day, own: armSummary({ sent: 100 }), reference: armSummary({ sent: 40 }) },
						{ day: day + 86_400_000, own: armSummary({ sent: 120 }), reference: null },
					],
				}),
			],
		});
		const wrapper = mountPage();
		// Both really render — the premise of the contradiction, not an assumption.
		expect(wrapper.find('[data-testid="measurement-standalone-note"]').exists()).toBe(true);
		expect(wrapper.find('[data-testid="measurement-quiet-relay"]').exists()).toBe(true);
		expect(wrapper.text()).not.toContain('Connecting a relay you already pay for');
		expect(wrapper.text()).not.toContain('You are sending entirely from your own server');
		wrapper.unmount();
	});

	it('leads with the cells that have traffic and still renders the quiet ones', () => {
		data.value = dashboard({
			cells: [
				// A cell nobody has sent through: still shown, it just does not lead.
				cellView({
					cellKey: 'campaign:apple',
					cell: { stream: 'campaign', destinationProvider: 'apple' },
					own: armSummary(),
					reference: armSummary(),
				}),
				cellView(),
			],
		});
		const wrapper = mountPage();
		const headings = wrapper.findAll('h3').map((heading) => heading.text());
		expect(headings).toHaveLength(2);
		expect(headings[0]).toContain('Gmail');
		expect(headings[1]).toContain('Apple');
		wrapper.unmount();
	});
});
