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
import MeasurementPage from '../measurement.vue';
import { armSummary, cellView } from '~/components/delivery/__tests__/measurementFixtures';
import type { DeliverabilityDashboard } from '~/utils/deliverabilityMeasurement';
import MeasurementCellCard from '~/components/delivery/MeasurementCellCard.vue';
import MeasurementGateList from '~/components/delivery/MeasurementGateList.vue';
import QueryBoundary from '~/components/ui/QueryBoundary.vue';

const WINDOW_END = Date.UTC(2026, 6, 16);
const WINDOW_START = WINDOW_END - 7 * 24 * 60 * 60 * 1000;

function dashboard(overrides: Partial<DeliverabilityDashboard> = {}): DeliverabilityDashboard {
	return {
		generatedAt: WINDOW_END,
		windowStart: WINDOW_START,
		windowEnd: WINDOW_END,
		referenceTransportId: 'ses',
		hasSeedCoverage: false,
		cells: [cellView()],
		...overrides,
	};
}

const data: Ref<DeliverabilityDashboard | undefined> = ref(undefined);
const isLoading = ref(false);
const error: Ref<Error | null> = ref(null);

beforeEach(() => {
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

	it('switches to the standalone feature and states it plainly (D14)', () => {
		data.value = dashboard({
			referenceTransportId: null,
			cells: [cellView({ reference: null })],
		});
		const wrapper = mountPage();
		expect(wrapper.find('h1').text()).toBe('Warm-up autopilot');
		const note = wrapper.find('[data-testid="measurement-standalone-note"]');
		expect(note.exists()).toBe(true);
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
