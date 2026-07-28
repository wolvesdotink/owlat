// @vitest-environment happy-dom
/**
 * THE INDEPENDENCE SCREEN, and the arithmetic behind the numbers on it.
 *
 * Two halves, deliberately in one file: the PURE projection (the date, the share,
 * the money) and the MOUNTED screen that renders it. Testing only the screen
 * would let a wrong date pass because the copy read plausibly; testing only the
 * arithmetic would let a correct date never reach the page.
 *
 * The D14 variant is the point of the second half: with no relay the screen is
 * "Warm-up autopilot" with a capacity headline, not a degraded "Sending
 * independence" — and nothing on it renders as a warning or a setup nag (D2).
 */
import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref, type Ref } from 'vue';
import {
	INDEPENDENCE_PROJECTION_MIN_DAYS,
	independenceShare,
	ownSendsSince,
	projectIndependenceDate,
	spendAvoidedMinorUnits,
	type IndependenceDayPoint,
} from '@owlat/shared/deliverabilityIndependence';
import IndependencePage from '../independence.vue';
import IndependenceTrendChart from '~/components/delivery/IndependenceTrendChart.vue';
import RampConfirmDialog from '~/components/delivery/RampConfirmDialog.vue';
import QueryBoundary from '~/components/ui/QueryBoundary.vue';
import {
	DAY_MS,
	NOW,
	independenceSummary,
	risingSeries,
} from '~/components/delivery/__tests__/rampFixtures';
import type { IndependenceSummary } from '~/utils/deliverabilityRamp';

describe('independence arithmetic', () => {
	it('sums the window rather than averaging per-day shares', () => {
		// A quiet day at 100% own must not outweigh a busy day at 10%.
		const points: IndependenceDayPoint[] = [
			{ day: NOW - DAY_MS, own: 1, reference: 0 },
			{ day: NOW, own: 100, reference: 900 },
		];
		expect(independenceShare(points)).toBeCloseTo(101 / 1001, 6);
	});

	it('answers null for a window nobody sent in, never 0%', () => {
		expect(independenceShare([{ day: NOW, own: 0, reference: 0 }])).toBeNull();
	});

	it('projects the date the relay stops carrying mail from the observed slope', () => {
		const projection = projectIndependenceDate({
			points: risingSeries(20),
			now: NOW,
			hasReferenceTransport: true,
		});
		expect(projection.kind).toBe('projected');
		if (projection.kind !== 'projected') return;
		expect(projection.at).toBeGreaterThan(NOW);
		expect(projection.dailyGainPp).toBeGreaterThan(0);
	});

	it('holds rather than guessing below the minimum history', () => {
		const points = risingSeries(INDEPENDENCE_PROJECTION_MIN_DAYS - 1);
		const projection = projectIndependenceDate({ points, now: NOW, hasReferenceTransport: true });
		expect(projection.kind).toBe('insufficient_data');
	});

	it('reports a flat or retreating line as not advancing, never as a date', () => {
		const flat: IndependenceDayPoint[] = Array.from({ length: 10 }, (_, index) => ({
			day: NOW - (10 - index) * DAY_MS,
			own: 100,
			reference: 100,
		}));
		expect(
			projectIndependenceDate({ points: flat, now: NOW, hasReferenceTransport: true }).kind
		).toBe('not_advancing');
	});

	it('is already independent with no relay — not "unknown"', () => {
		expect(
			projectIndependenceDate({ points: [], now: NOW, hasReferenceTransport: false }).kind
		).toBe('already_independent');
	});

	it('survives a hostile series without producing NaN', () => {
		const hostile: IndependenceDayPoint[] = [
			{ day: Number.NaN, own: 5, reference: 5 },
			{ day: NOW, own: Number.POSITIVE_INFINITY, reference: 1 },
			{ day: NOW - DAY_MS, own: -10, reference: 5 },
		];
		const share = independenceShare(hostile);
		expect(share === null || Number.isFinite(share)).toBe(true);
	});

	it('computes spend avoided from a supplied price and refuses to invent one', () => {
		expect(spendAvoidedMinorUnits({ ownSends: 12_500, minorUnitsPerThousand: 100 })).toBe(1250);
		expect(spendAvoidedMinorUnits({ ownSends: 12_500, minorUnitsPerThousand: null })).toBeNull();
		expect(spendAvoidedMinorUnits({ ownSends: 0, minorUnitsPerThousand: 100 })).toBe(0);
	});

	it('counts month-to-date own sends from the month boundary only', () => {
		const points: IndependenceDayPoint[] = [
			{ day: NOW - 40 * DAY_MS, own: 1000, reference: 0 },
			{ day: NOW, own: 25, reference: 0 },
		];
		expect(ownSendsSince(points, NOW - DAY_MS)).toBe(25);
	});
});

const data: Ref<IndependenceSummary | undefined> = ref(undefined);
const isLoading = ref(false);
const error: Ref<Error | null> = ref(null);

beforeEach(() => {
	data.value = independenceSummary();
	isLoading.value = false;
	error.value = null;
	vi.stubGlobal('useHead', vi.fn());
	vi.stubGlobal('definePageMeta', vi.fn());
	vi.stubGlobal('navigateTo', vi.fn());
	vi.stubGlobal('useOrganizationQuery', () => ({ data, isLoading, error, refetch: vi.fn() }));
});

const passthroughCard = { template: '<div><slot /></div>' };

function mountPage() {
	return mount(IndependencePage, {
		global: {
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
				DeliveryRampConfirmDialog: RampConfirmDialog,
			},
		},
	});
}

describe('independence screen', () => {
	it('leads with the share of mail the own server carries', () => {
		const wrapper = mountPage();
		expect(wrapper.find('h1').text()).toBe('Sending independence');
		expect(wrapper.find('[data-testid="independence-headline"]').text()).toContain('42');
		wrapper.unmount();
	});

	it('draws the stacked series with both arms and offers the numbers as a table', () => {
		const wrapper = mountPage();
		expect(wrapper.find('[data-testid="independence-chart"]').exists()).toBe(true);
		expect(wrapper.find('[data-testid="own-band"]').exists()).toBe(true);
		expect(wrapper.find('[data-testid="reference-band"]').exists()).toBe(true);
		// Not colour-only: the same numbers exist as a real table.
		expect(wrapper.findAll('table').length).toBeGreaterThan(0);
		wrapper.unmount();
	});

	it('states the projected date and the spend it replaces', () => {
		const wrapper = mountPage();
		expect(wrapper.find('[data-testid="independence-projection"]').text()).toContain('stop paying');
		// No price recorded: it says what would show the figure, never a guess.
		expect(wrapper.find('[data-testid="independence-spend"]').text()).toContain('per thousand');
		wrapper.unmount();
	});

	it('becomes Warm-up autopilot with no relay, headed by today’s capacity (D14)', () => {
		data.value = independenceSummary({
			referenceTransportId: null,
			ownShare: 1,
			projection: { kind: 'already_independent' },
			relayRemoval: { kind: 'safe' },
		});
		const wrapper = mountPage();
		expect(wrapper.find('h1').text()).toBe('Warm-up autopilot');
		expect(wrapper.find('[data-testid="independence-headline"]').text()).toBe('4000');
		expect(wrapper.find('[data-testid="independence-headline-note"]').text()).toContain(
			'can go out from your own server today'
		);
		// Nothing to become independent OF — and no relay-removal section at all.
		expect(wrapper.find('[data-testid="relay-removal-open"]').exists()).toBe(false);
		expect(wrapper.text()).not.toMatch(/setup incomplete|warning|error/i);
		wrapper.unmount();
	});

	it('renders a young account calmly instead of quoting 0%', () => {
		data.value = independenceSummary({
			ownShare: null,
			series: [],
			projection: { kind: 'insufficient_data', usableDays: 1 },
			monthToDateOwnSends: 0,
		});
		const wrapper = mountPage();
		expect(wrapper.find('[data-testid="independence-headline"]').text()).toBe('—');
		expect(wrapper.find('[data-testid="independence-chart-empty"]').exists()).toBe(true);
		expect(wrapper.find('[data-testid="independence-projection"]').text()).toContain(
			'Not enough history yet'
		);
		wrapper.unmount();
	});
});
