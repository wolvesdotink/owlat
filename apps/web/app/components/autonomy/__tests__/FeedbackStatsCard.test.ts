/**
 * The approved | edited | rejected distribution bar.
 *
 * Each segment is a full-width layer slid to its CUMULATIVE end (so the bar
 * never animates layout), with earlier segments painted over later ones. The
 * regression worth pinning is the geometry: sliding each layer to its own
 * share instead of the running total would stack every segment at the left
 * edge and misreport the split.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';

import FeedbackStatsCard from '../FeedbackStatsCard.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

function segments(stats: Record<string, { approved: number; edited: number; rejected: number }>) {
	const wrapper = mount(FeedbackStatsCard, {
		props: { stats },
		global: {
			plugins: [createTestI18n()],
			stubs: { UiCard: { template: '<div><slot /></div>' }, UiIconBox: true },
		},
	});
	// Paint order: the later layer is on top, so the visible segments read
	// left to right in reverse DOM order.
	return wrapper.findAll('.ui-meter-fill').map((layer) => ({
		color: layer.classes().find((c) => c.startsWith('bg-')),
		end: Number((layer.element as HTMLElement).style.getPropertyValue('--ui-meter-value')),
		style: layer.attributes('style') ?? '',
		classes: layer.classes(),
	}));
}

describe('FeedbackStatsCard distribution bar', () => {
	it('slides each layer to the running total so the boundaries match the split', () => {
		const layers = segments({
			support: { approved: 4, edited: 3, rejected: 1 },
			sales: { approved: 1, edited: 0, rejected: 1 },
		});
		// approved 5/10, edited 3/10, rejected 2/10.
		expect(layers.map(({ color, end }) => [color, end])).toEqual([
			['bg-error', 100],
			['bg-warning', 80],
			['bg-success', 50],
		]);
	});

	it('moves the layers with transform only, never width', () => {
		for (const layer of segments({ a: { approved: 2, edited: 1, rejected: 1 } })) {
			expect(layer.style).not.toMatch(/(^|;)\s*width/);
			expect(layer.classes).toContain('transition-transform');
		}
	});

	it('omits an empty category and keeps the others where they belong', () => {
		const layers = segments({ a: { approved: 3, edited: 0, rejected: 1 } });
		expect(layers.map(({ color, end }) => [color, end])).toEqual([
			['bg-error', 100],
			['bg-success', 75],
		]);
	});

	it('draws no bar without data', () => {
		expect(segments({ a: { approved: 0, edited: 0, rejected: 0 } })).toEqual([]);
	});
});
