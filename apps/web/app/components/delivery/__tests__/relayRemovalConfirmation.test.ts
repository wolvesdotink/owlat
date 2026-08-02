// @vitest-environment happy-dom
/**
 * REMOVING THE REFERENCE TRANSPORT BELOW GRADUATION.
 *
 * A named risk mitigation in the plan, and the reason it needs its own suite: an
 * operator who has watched the share climb to 80% will reasonably assume the
 * relay is nearly redundant. It is not — pulling it moves the remaining 20% of
 * every ungraduated cell at once, and the screen has to say which cells, and
 * when it would be safe instead.
 */
import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref, type Ref } from 'vue';
import {
	assessRelayRemoval,
	RELAY_REMOVAL_CONFIRMATION,
} from '@owlat/shared/deliverabilityIndependence';
import IndependencePage from '~/pages/dashboard/delivery/independence.vue';
import IndependenceTrendChart from '../IndependenceTrendChart.vue';
import RampConfirmDialog from '../RampConfirmDialog.vue';
import QueryBoundary from '~/components/ui/QueryBoundary.vue';
import { DAY_MS, NOW, independenceSummary } from './rampFixtures';
import type { IndependenceSummary } from '~/utils/deliverabilityRamp';

describe('relay removal safety', () => {
	it('is safe only when every cell has graduated', () => {
		const graduated = assessRelayRemoval({
			cells: [
				{ stream: 'campaign', cellKey: 'campaign:gmail', ownShare: 1, graduatedAt: NOW },
				{ stream: 'automation', cellKey: 'automation:gmail', ownShare: 1, graduatedAt: NOW },
			],
			projection: { kind: 'already_independent' },
		});
		expect(graduated.kind).toBe('safe');
	});

	it('names the cells still leaning on the relay, worst first, with the projected date', () => {
		const result = assessRelayRemoval({
			cells: [
				{ stream: 'campaign', cellKey: 'campaign:gmail', ownShare: 0.8, graduatedAt: undefined },
				{
					stream: 'automation',
					cellKey: 'automation:yahoo',
					ownShare: 0.1,
					graduatedAt: undefined,
				},
				{ stream: 'transactional', cellKey: 'transactional:apple', ownShare: 1, graduatedAt: NOW },
			],
			projection: { kind: 'projected', at: NOW + 10 * DAY_MS, dailyGainPp: 2 },
		});
		expect(result.kind).toBe('unsafe');
		if (result.kind !== 'unsafe') return;
		expect(result.dependentCells).toEqual(['automation:yahoo', 'campaign:gmail']);
		expect(result.projectedSafeAt).toBe(NOW + 10 * DAY_MS);
	});
});

const data: Ref<IndependenceSummary | undefined> = ref(undefined);

beforeEach(() => {
	data.value = independenceSummary();
	vi.stubGlobal('useHead', vi.fn());
	vi.stubGlobal('definePageMeta', vi.fn());
	vi.stubGlobal('navigateTo', vi.fn());
	vi.stubGlobal('useOrganizationQuery', () => ({
		data,
		isLoading: ref(false),
		error: ref(null),
		refetch: vi.fn(),
	}));
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

describe('the independence screen’s relay-removal route', () => {
	it('surfaces the projected safe date before anything is confirmed', () => {
		const wrapper = mountPage();
		// One cell reads as one cell. The card, the dialog and the endpoint's own
		// refusal count with the same helper, so none of them can say "1 cells".
		expect(wrapper.find('[data-testid="relay-removal-dependent"]').text()).toContain(
			'1 cell has not graduated yet'
		);
		expect(wrapper.find('[data-testid="relay-removal-safe-date"]').text()).toContain(
			'safe to disconnect around'
		);
		wrapper.unmount();
	});

	it('requires the consequence-naming phrase before it will go anywhere', async () => {
		const wrapper = mountPage();
		await wrapper.find('[data-testid="relay-removal-open"]').trigger('click');
		expect(wrapper.find('[data-testid="relay-removal-consequence"]').text()).toContain(
			'immediately — not gradually'
		);
		expect(wrapper.find('[data-testid="relay-removal-dialog-date"]').exists()).toBe(true);

		const submit = wrapper.find('[data-testid="ramp-confirm-submit"]');
		expect(submit.attributes('disabled')).toBeDefined();
		await wrapper.find('[data-testid="ramp-confirm-input"]').setValue(RELAY_REMOVAL_CONFIRMATION);
		expect(
			wrapper.find('[data-testid="ramp-confirm-submit"]').attributes('disabled')
		).toBeUndefined();
		wrapper.unmount();
	});

	it('says plainly when there is nothing left to lose by disconnecting', async () => {
		data.value = independenceSummary({ relayRemoval: { kind: 'safe' } });
		const wrapper = mountPage();
		expect(wrapper.find('[data-testid="relay-removal-safe"]').text()).toContain(
			'would not move any traffic'
		);

		// AND THE DIALOG UNDER THE CARD SAYS THE SAME THING. It is rendered in the
		// safe state too — the button sits outside the card's branches — so a card
		// reading "every cell has graduated" above a dialog reading "this cannot be
		// treated as safe" is two contradictory claims about one click, and the
		// dialog's was the false one: this button only navigates, and the endpoint
		// lets a graduated deployment through with no phrase at all.
		await wrapper.find('[data-testid="relay-removal-open"]').trigger('click');
		const consequence = wrapper.find('[data-testid="relay-removal-consequence"]').text();
		expect(consequence).toContain('Every cell has graduated');
		expect(consequence).not.toContain('could not be established');
		expect(consequence).not.toContain('cannot be treated as safe');
		expect(wrapper.find('[data-testid="relay-removal-dialog-date"]').exists()).toBe(false);
		wrapper.unmount();
	});

	it('admits when no safe date can be projected rather than inventing one', async () => {
		data.value = independenceSummary({
			projection: { kind: 'not_advancing' },
			relayRemoval: { kind: 'unsafe', dependentCells: ['campaign:gmail'], projectedSafeAt: null },
		});
		const wrapper = mountPage();
		expect(wrapper.find('[data-testid="relay-removal-safe-date"]').text()).toContain(
			'no projected safe date yet'
		);
		await wrapper.find('[data-testid="relay-removal-open"]').trigger('click');
		expect(wrapper.find('[data-testid="relay-removal-dialog-date"]').exists()).toBe(false);
		wrapper.unmount();
	});
});
