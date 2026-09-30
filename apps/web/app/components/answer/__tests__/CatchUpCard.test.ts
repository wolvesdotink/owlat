// @vitest-environment happy-dom
/**
 * The catch-up card (plan §03):
 *   - sentences with one date marker per source message, at most three, oldest
 *     first; a marker reveals its message;
 *   - "They are asking for", ticked as the draft covers each ask, with a short
 *     reason only when one was given;
 *   - "Files in this thread" as chips: click attaches, dragging carries the file;
 *   - a short thread with 2+ asks shows only the checklist;
 *   - a skeleton while loading, nothing when there is nothing to show.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { defineComponent, h } from 'vue';
import { mount } from '@vue/test-utils';

import CatchUpCard, { type CatchUpMessage } from '../CatchUpCard.vue';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';
import { THREAD_FILE_DRAG_TYPE } from '~/utils/answerThreadFiles';
import { auditA11y } from '~/__tests__/a11y';

const day = (d: number) => Date.UTC(2026, 8, d, 9, 0);
const MESSAGES: CatchUpMessage[] = [
	{ _id: 'm1', receivedAt: day(1), fromAddress: 'jonas@example.com', fromName: 'Jonas Berg' },
	{ _id: 'm2', receivedAt: day(3), fromAddress: 'ada@example.com', fromName: 'Ada' },
	{ _id: 'm3', receivedAt: day(10), fromAddress: 'jonas@example.com', fromName: 'Jonas Berg' },
	{
		_id: 'm4',
		receivedAt: day(28),
		fromAddress: 'jonas@example.com',
		fromName: 'Jonas Berg',
		attachments: [
			{ filename: 'po-bp-2231.pdf', contentType: 'application/pdf', size: 2048, partIndex: '2' },
		],
	},
];

const CARD = {
	sentences: [
		{ text: 'Renewed 40 seats.', sourceMessageIds: ['m4', 'm3', 'm2', 'm1'] },
		{ text: 'PO BP-2231 goes on every invoice.', sourceMessageIds: ['m2', 'unknown'] },
	],
	asks: [
		{ id: 'ask_1', text: 'The September invoice as a PDF', sourceMessageId: 'm4' },
		{ id: 'ask_2', text: 'PO BP-2231 printed on it', sourceMessageId: 'm4' },
	],
	messageCount: 4,
	locale: 'en',
	generatedAt: 1,
};

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

const Skeleton = defineComponent({ name: 'UiSkeleton', setup: () => () => h('div') });

function mountCard(props: Record<string, unknown>) {
	return mount(CatchUpCard, {
		props: { catchUp: CARD, messages: MESSAGES, ...props },
		global: { plugins: [createTestI18n()], components: { UiSkeleton: Skeleton } },
	});
}

describe('CatchUpCard', () => {
	it('says how far back it goes, and marks each sentence with its sources', async () => {
		const w = mountCard({});
		expect(w.get('[data-testid="catch-up-meta"]').text()).toBe('4 messages since Sep 1');
		const markers = w.findAll('[data-testid="catch-up-marker"]');
		// Three for the first sentence (oldest first, capped), one for the second;
		// an unknown source gets none.
		expect(markers.map((m) => m.text())).toEqual(['Sep 1', 'Sep 3', 'Sep 10', 'Sep 3']);
		expect(markers[0]!.attributes('aria-label')).toBe('Show the message from Jonas Berg, Sep 1');
		await markers[1]!.trigger('click');
		expect(w.emitted('reveal')).toEqual([['m2']]);
		expectFullyLocalized(w);
	});

	it('ticks the asks the draft covers, with a reason only when given', () => {
		const w = mountCard({ covered: ['ask_2'], hints: { ask_2: '"PO BP-2231 is on it"' } });
		const asks = w.findAll('[data-testid="catch-up-ask"]');
		expect(asks.map((a) => a.attributes('data-covered'))).toEqual(['false', 'true']);
		expect(asks[0]!.text()).toContain('Not covered yet:');
		expect(asks[1]!.text()).toContain('Covered by your draft:');
		expect(w.findAll('[data-testid="catch-up-ask-hint"]').map((x) => x.text())).toEqual([
			'"PO BP-2231 is on it"',
		]);
	});

	it('offers the thread files: click attaches, drag carries the file', async () => {
		const w = mountCard({});
		const chip = w.get('[data-testid="catch-up-file"]');
		expect(chip.text()).toContain('po-bp-2231.pdf');
		expect(chip.attributes('draggable')).toBe('true');
		await chip.trigger('click');
		expect(w.emitted('attach')?.[0]?.[0]).toMatchObject({
			messageId: 'm4',
			partIndex: '2',
			filename: 'po-bp-2231.pdf',
		});

		const data = new Map<string, string>();
		await chip.trigger('dragstart', {
			dataTransfer: { setData: (k: string, v: string) => data.set(k, v), effectAllowed: '' },
		});
		expect(JSON.parse(data.get(THREAD_FILE_DRAG_TYPE)!)).toMatchObject({ messageId: 'm4' });
	});

	it('disables the chip being attached, and every chip without a composer', () => {
		expect(
			mountCard({ attaching: 'm4:2' }).get('[data-testid="catch-up-file"]').attributes('disabled')
		).toBeDefined();
		const w = mountCard({ canAttach: false });
		expect(w.get('[data-testid="catch-up-file"]').attributes('draggable')).toBe('false');
	});

	it('shows only the checklist for a short thread with asks', () => {
		const w = mountCard({ catchUp: { ...CARD, sentences: [] } });
		expect(w.find('[data-testid="catch-up-sentences"]').exists()).toBe(false);
		expect(w.find('[data-testid="catch-up-files"]').exists()).toBe(false);
		expect(w.findAll('[data-testid="catch-up-ask"]')).toHaveLength(2);
		expect(w.text()).toContain('They are asking for');
	});

	it('is a quiet skeleton while loading, and nothing without a card', () => {
		expect(
			mountCard({ catchUp: null, loading: true }).find('[data-testid="catch-up-loading"]').exists()
		).toBe(true);
		const empty = mountCard({ catchUp: null });
		expect(empty.find('section').exists()).toBe(false);
	});

	it('passes an accessibility audit', async () => {
		const violations = await auditA11y(CatchUpCard, {
			props: { catchUp: CARD, messages: MESSAGES, covered: ['ask_1'] },
			global: { plugins: [createTestI18n()], components: { UiSkeleton: Skeleton } },
		});
		expect(violations).toEqual([]);
	});
});
