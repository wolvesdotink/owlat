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
import { isRef, ref, type Ref } from 'vue';
import {
	INDEPENDENCE_PROJECTION_MIN_DAYS,
	independenceShare,
	ownSendsSince,
	projectIndependenceDate,
	spendAvoidedMinorUnits,
	type IndependenceDayPoint,
} from '@owlat/shared/deliverabilityIndependence';
import IndependencePage from '../advanced/independence.vue';
import IndependenceTrendChart from '~/components/delivery/IndependenceTrendChart.vue';
import RampConfirmDialog from '~/components/delivery/RampConfirmDialog.vue';
import QueryBoundary from '~/components/ui/QueryBoundary.vue';
import {
	DAY_MS,
	NOW,
	independenceSummary,
	risingSeries,
} from '~/components/delivery/__tests__/rampFixtures';
import type { IndependenceSummary } from '~/utils/deliverabilityIndependenceCopy';

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

	/**
	 * A CORRUPT PRICE IS UNANSWERABLE AT ANY VOLUME. If the sends guard ran first,
	 * a zero-volume month would answer `0` off a NaN price and the screen would
	 * print "$0.00 avoided" instead of asking for the price it never had.
	 */
	it('answers "cannot say" on an unusable price even when there were no sends', () => {
		expect(spendAvoidedMinorUnits({ ownSends: 0, minorUnitsPerThousand: Number.NaN })).toBeNull();
		expect(
			spendAvoidedMinorUnits({ ownSends: 0, minorUnitsPerThousand: Number.POSITIVE_INFINITY })
		).toBeNull();
		expect(spendAvoidedMinorUnits({ ownSends: 0, minorUnitsPerThousand: -1 })).toBeNull();
		expect(
			spendAvoidedMinorUnits({ ownSends: 12_500, minorUnitsPerThousand: Number.NaN })
		).toBeNull();
	});

	it('counts month-to-date own sends from the month boundary only', () => {
		const points: IndependenceDayPoint[] = [
			{ day: NOW - 40 * DAY_MS, own: 1000, reference: 0 },
			{ day: NOW, own: 25, reference: 0 },
		];
		expect(ownSendsSince(points, NOW - DAY_MS)).toBe(25);
	});
});

const useHead = vi.fn();

/**
 * The title the page handed `useHead`. It is passed as a computed so the tab can
 * follow the D14 rename, so the assertion has to unwrap it.
 */
function headTitle(): string {
	const call = useHead.mock.calls.at(-1)?.[0] as unknown;
	const options = isRef(call) ? (call.value as { title?: unknown }) : (call as { title?: unknown });
	return typeof options?.title === 'string' ? options.title : '';
}
const data: Ref<IndependenceSummary | undefined> = ref(undefined);
const isLoading = ref(false);
const error: Ref<Error | null> = ref(null);

beforeEach(() => {
	data.value = independenceSummary();
	isLoading.value = false;
	error.value = null;
	useHead.mockClear();
	vi.stubGlobal('useHead', useHead);
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

	it('renders the month-to-date spend avoided once a relay price is recorded', () => {
		data.value = independenceSummary({
			// 8¢ per thousand against 12,500 own sends this month.
			spendAvoidedMinorUnits: 1000,
			spendAvoidedCurrency: 'USD',
		});
		const wrapper = mountPage();
		const spend = wrapper.find('[data-testid="independence-spend"]').text();
		expect(spend).toContain('$10.00');
		expect(spend).toContain('relay spend avoided this month');
		wrapper.unmount();
	});

	it('reads a minor unit off its own currency rather than assuming hundredths', () => {
		// JPY has NO minor unit: 1,000 minor units is ¥1,000, not ¥10.00.
		data.value = independenceSummary({
			spendAvoidedMinorUnits: 1000,
			spendAvoidedCurrency: 'JPY',
		});
		const wrapper = mountPage();
		expect(wrapper.find('[data-testid="independence-spend"]').text()).toContain('1,000');
		wrapper.unmount();
	});

	/**
	 * TWO RELAY KINDS: no single arm to NAME, and every figure still about a relay
	 * (#513). The screen used to key its whole variant on `referenceTransportId`,
	 * so this deployment read as "Warm-up autopilot" with a capacity headline —
	 * over a summary whose own share and removal warning were about a relay.
	 */
	it('stays the independence screen when two relays leave no single one to name', () => {
		data.value = independenceSummary({ referenceTransportId: null, isRelayConfigured: true });
		const wrapper = mountPage();

		expect(wrapper.find('h1').text()).toBe('Sending independence');
		expect(headTitle()).toContain('Sending independence');
		// The share, not today's capacity.
		expect(wrapper.find('[data-testid="independence-headline"]').text()).toContain('42');
		// The relay is unnamed, not absent: plural copy, never the standalone
		// sentence that promises there is nothing to move away from.
		expect(wrapper.text()).toContain('instead of the relays you have connected');
		expect(wrapper.text()).not.toContain('There is no relay to move away from');
		// And the dangerous route off the page is still offered.
		expect(wrapper.find('[data-testid="relay-removal-open"]').exists()).toBe(true);
		wrapper.unmount();
	});

	it('becomes Warm-up autopilot with no relay, headed by today’s capacity (D14)', () => {
		data.value = independenceSummary({
			referenceTransportId: null,
			isRelayConfigured: false,
			ownShare: 1,
			projection: { kind: 'already_independent' },
			relayRemoval: { kind: 'safe' },
		});
		const wrapper = mountPage();
		expect(wrapper.find('h1').text()).toBe('Warm-up autopilot');
		// The browser tab follows the h1 — the D14 rename applied all the way.
		expect(headTitle()).toContain('Warm-up autopilot');
		// The headline is formatted the way the sentence under it is — one figure,
		// not "4000" sitting over "4,000 more messages".
		expect(wrapper.find('[data-testid="independence-headline"]').text()).toBe('4,000');
		const note = wrapper.find('[data-testid="independence-headline-note"]').text();
		expect(note).toContain('4,000');
		expect(note).toContain('can go out from your own server today');
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
