// @vitest-environment happy-dom
/**
 * Answer mode's view of the thread (SPEC §7):
 *   - a personal thread: the brief with selectable items, all open ones selected;
 *   - a shared (team) mailbox: the actions only (for the team, waiting on
 *     others), never a latest update or "where things stand", and never the
 *     catch-up summary card.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { briefView, evidence, item } from '~/utils/__tests__/threadBriefFixtures';

const view = ref<unknown>(undefined);
vi.mock('~/composables/useThreadBrief', async () => {
	const { computed } = await import('vue');
	return {
		useThreadBrief: () => ({
			view,
			brief: computed(() => {
				const v = view.value as { mode?: string } | undefined;
				return v === undefined ? undefined : v?.mode === 'brief' ? v : null;
			}),
		}),
	};
});

beforeAll(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
});

const { default: AnswerBriefCard } = await import('../AnswerBriefCard.vue');

const Plain = defineComponent({ setup: () => () => h('span') });

function mountCard() {
	return mount(AnswerBriefCard, {
		props: { threadId: 't1', shown: 'summary', layout: 'split', messages: [], canAttach: true },
		global: {
			plugins: [createTestI18n()],
			components: { UiSkeleton: Plain, UiAvatar: Plain, PostboxOverflowMenu: Plain },
			stubs: { CatchUpCard: { template: '<div data-testid="catch-up" />' } },
		},
	});
}

describe('AnswerBriefCard', () => {
	it('shows the personal brief with every open item selected', async () => {
		view.value = briefView();
		const w = mountCard();
		await flushPromises();
		expect(w.find('[data-testid="thread-brief"]').exists()).toBe(true);
		const boxes = w.findAll('[data-testid="brief-item-select"]');
		expect(boxes.map((b) => (b.element as HTMLInputElement).checked)).toEqual([true, true]);
	});

	it('shows a shared mailbox its actions only, never a summary', async () => {
		const base = briefView();
		view.value = {
			mode: 'actions',
			threadRef: base.threadRef,
			interpretationRevision: 2,
			completeness: 'complete',
			waitingOnOthers: base.waitingOnOthers,
			unclear: [],
			activity: [],
			counts: base.counts,
			forTeam: [item({ id: 'r', text: 'Refund €129.00 for order #4471' })],
		};
		const w = mountCard();
		await flushPromises();
		const text = w.text();
		expect(w.find('[data-testid="brief-team-actions"]').exists()).toBe(true);
		expect(text).toContain('For the team');
		expect(text).toContain('Refund €129.00 for order #4471');
		expect(text).toContain('Waiting on others');
		expect(text).not.toContain('Latest update');
		expect(text).not.toContain('Where things stand');
		expect(w.find('[data-testid="catch-up"]').exists()).toBe(false);
		expect(w.find('[data-testid="thread-brief"]').exists()).toBe(false);
	});

	it('reveals the source of a pending change in a shared mailbox', async () => {
		const base = briefView();
		view.value = {
			mode: 'actions',
			threadRef: base.threadRef,
			interpretationRevision: 2,
			completeness: 'complete',
			waitingOnOthers: [],
			unclear: [],
			activity: [],
			counts: base.counts,
			forTeam: [
				item({
					id: 'r',
					text: 'Refund €129.00',
					pendingUpdate: {
						evidence: [evidence('m9', 'make it €99')],
						amount: { value: 99, currency: 'EUR' },
					},
				}),
			],
		};
		const w = mountCard();
		await flushPromises();
		const marker = w.get('[data-testid="brief-item-pending"] [data-testid="evidence-marker"]');
		await marker.trigger('click');
		expect(w.emitted('reveal')).toEqual([['m9']]);
	});
});
