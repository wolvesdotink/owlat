// @vitest-environment happy-dom
/**
 * The thread brief (SPEC §7, plan §4.1, §5, §8):
 *   - the blocks in order, every line with a source marker that names whose
 *     message and when, and a click on it cites that line;
 *   - item states as rings and chips, due dates, one primary reaction and the
 *     ⋯ menu, which emit what the person chose;
 *   - "Where things stand" strikes the replaced value;
 *   - an incomplete brief says so and never claims there is nothing to do;
 *   - no brief at all says why and offers the conversation;
 *   - Answer mode: checkboxes instead of rings, no reactions;
 *   - a phone folds everything after the items into one disclosure.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { defineComponent, h } from 'vue';
import { mount } from '@vue/test-utils';
import ThreadBrief from '../ThreadBrief.vue';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';
import { briefView, evidence, item, T0 } from '~/utils/__tests__/threadBriefFixtures';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

const Plain = defineComponent({ setup: () => () => h('span') });
/** The overflow menu, always open, so its items can be clicked. */
const MenuStub = defineComponent({
	props: { label: { type: String, default: '' } },
	setup:
		(props, { slots }) =>
		() =>
			h(
				'div',
				{ 'data-testid': 'item-menu', 'aria-label': props.label },
				slots['default']?.({ close: () => {} })
			),
});

const SOURCES: Record<string, { name: string; email: string; at: number }> = {
	m6: { name: 'Jonas Weber', email: 'jonas@kestrel.example', at: T0 },
	m1: { name: 'Jonas Weber', email: 'jonas@kestrel.example', at: T0 - 9 * 86_400_000 },
};

function mountBrief(props: Record<string, unknown> = {}) {
	return mount(ThreadBrief, {
		props: {
			brief: briefView(),
			sourceOf: (id: string) => SOURCES[id],
			compact: false,
			...props,
		},
		global: {
			plugins: [createTestI18n()],
			components: { UiSkeleton: Plain, UiAvatar: Plain, PostboxOverflowMenu: MenuStub },
		},
	});
}

describe('ThreadBrief', () => {
	it('shows the blocks, each line with a marker that cites it', async () => {
		const w = mountBrief();
		const text = w.text();
		for (const heading of [
			'Latest update',
			'Where things stand',
			'For you',
			'Waiting on others',
			'Activity',
			'People',
			'Files',
		]) {
			expect(text).toContain(heading);
		}
		const marker = w.findAll('[data-testid="evidence-marker"]')[0]!;
		expect(marker.text()).toBe('JW Oct 7');
		expect(marker.attributes('aria-label')).toBe('Show the source: Jonas Weber, Oct 7');
		await marker.trigger('click');
		expect(w.emitted('cite')).toEqual([['latest-0', 0]]);
		expectFullyLocalized(w);
	});

	it('strikes the value a later message replaced', () => {
		const standing = mountBrief().get('[data-testid="brief-standing"]');
		expect(standing.text()).toContain('Launch');
		expect(standing.get('b').text()).toBe('Nov 14');
		expect(standing.get('s').text()).toContain('Oct 31');
	});

	it('draws item states, due dates and the primary reaction', async () => {
		const brief = briefView({
			forYou: [
				item({
					id: 'a',
					text: 'Approve the quote',
					intent: 'decision',
					facets: ['payment'],
					primaryReaction: 'replyWithStance',
					due: { phrase: 'Fri', at: T0 + 86_400_000 * 10, isAmbiguous: false },
				}),
				item({
					id: 'b',
					text: 'Make the design changes',
					disposition: 'accepted',
					stateKey: 'answeredStillToDo',
				}),
				item({
					id: 'c',
					text: 'Send design v2',
					intent: 'promise',
					status: 'done',
					completion: 'asserted',
					stateKey: 'markedDoneByYou',
					primaryReaction: 'markDone',
				}),
				item({ id: 'd', text: 'Cover shipping costs', verify: 'proposal' }),
			],
		});
		const w = mountBrief({ brief });
		const items = w.findAll('[data-testid="brief-items-forYou"] [data-testid="brief-item"]');
		expect(items.map((i) => i.attributes('data-state'))).toEqual([
			'open',
			'answeredStillToDo',
			'markedDoneByYou',
			'open',
		]);
		expect(
			items.map((i) => i.find('[data-testid="brief-item-ring"]').attributes('data-ring'))
		).toEqual(['open', 'half', 'done', 'proposal']);
		expect(items[0]!.text()).toContain('due ');
		expect(items[0]!.text()).toContain('decision · payment');
		expect(items[1]!.get('[data-testid="brief-item-state"]').text()).toBe('Answered, still to do');
		expect(items[2]!.get('[data-testid="brief-item-state"]').text()).toBe('Marked done by you');
		expect(items[3]!.text()).toContain('Check this: Cover shipping costs');

		await items[0]!.get('[data-testid="brief-item-primary"]').trigger('click');
		// A done item offers Undo, not a reaction; a proposal offers Track.
		expect(items[2]!.find('[data-testid="brief-item-primary"]').exists()).toBe(false);
		await items[2]!.get('[data-action="undo"]').trigger('click');
		expect(items[3]!.get('[data-testid="brief-item-primary"]').text()).toBe('Track');
		await items[3]!.get('[data-testid="brief-item-primary"]').trigger('click');
		const emitted = (w.emitted('react') ?? []).map(([i, action]) => [
			(i as { id: string }).id,
			action,
		]);
		expect(emitted).toEqual([
			['a', 'replyWithStance'],
			['c', 'undo'],
			['d', 'confirmProposal'],
		]);
	});

	it('offers the rest in the ⋯ menu, without team verbs', async () => {
		const w = mountBrief();
		const contract = w.findAll('[data-testid="brief-item"]')[1]!;
		const actions = contract.findAll('[data-action]').map((b) => b.attributes('data-action'));
		expect(actions).toEqual(['reply', 'decline', 'markDone']);
		await contract.get('[data-action="markDone"]').trigger('click');
		expect(w.emitted('react')?.[0]?.[1]).toBe('markDone');
	});

	it('lets a phone confirm a proposal from the ⋯ menu', async () => {
		const brief = briefView({
			forYou: [item({ id: 'p', text: 'Cover shipping costs', verify: 'proposal' })],
		});
		const w = mountBrief({ brief, compact: true });
		const proposal = w.get('[data-testid="brief-item"]');
		expect(proposal.find('[data-testid="brief-item-primary"]').exists()).toBe(false);
		const actions = proposal.findAll('[data-action]').map((b) => b.attributes('data-action'));
		expect(actions).toEqual(['confirmProposal', 'notARequest']);
		expect(proposal.get('[data-action="confirmProposal"]').text()).toBe('Track');
		await proposal.get('[data-action="confirmProposal"]').trigger('click');
		expect(w.emitted('react')?.[0]?.[1]).toBe('confirmProposal');
	});

	it('shows an unconfirmed change as "Check this change" with Confirm', async () => {
		const brief = briefView({
			forYou: [
				item({
					id: 'q',
					text: 'Approve the revised quote',
					pendingUpdate: {
						evidence: [evidence('m6', 'make it €5,000 instead')],
						due: { phrase: 'by Monday', at: Date.UTC(2026, 9, 26), isAmbiguous: false },
						amount: { value: 5000, currency: 'EUR' },
					},
				}),
			],
		});
		const w = mountBrief({ brief });
		const pending = w.get('[data-testid="brief-item-pending"]');
		expect(pending.text()).toContain('Check this change:');
		expect(pending.text()).toContain('€5,000.00');
		expect(pending.text()).toContain('due ');
		await pending.get('[data-testid="evidence-marker"]').trigger('click');
		expect(w.emitted('cite')).toEqual([['q~pending', 0]]);
		await pending.get('[data-testid="brief-item-pending-confirm"]').trigger('click');
		expect(w.emitted('react')?.[0]?.[1]).toBe('confirmProposal');

		const readOnly = mountBrief({ brief, selectable: true });
		expect(readOnly.find('[data-testid="brief-item-pending-confirm"]').exists()).toBe(false);
		expect(readOnly.find('[data-testid="brief-item-pending"]').exists()).toBe(true);
	});

	it('says when it is incomplete, and never that there is nothing to do', async () => {
		const w = mountBrief({
			brief: briefView({
				completeness: 'partial',
				gap: { interpretedMessages: 2, totalMessages: 3, reason: 'tooLong' },
				forYou: [],
			}),
		});
		const banner = w.get('[data-testid="brief-incomplete"]');
		expect(banner.text()).toContain('Partly read.');
		expect(banner.text()).toContain('2 of 3 messages are in this overview.');
		expect(w.get('[data-testid="brief-items-forYou-empty"]').text()).toBe(
			'Nothing found in the part that was read.'
		);
		expect(w.text()).not.toContain('Nothing for you');
		await w.get('[data-testid="brief-open-conversation"]').trigger('click');
		expect(w.emitted('open-conversation')).toHaveLength(1);
	});

	it('never says nothing to do while For you items are still loading', () => {
		const brief = briefView({
			forYou: [],
			counts: { forYou: 1, forTeam: 0, waitingOnOthers: 1, unclear: 0, closed: 0, hidden: 0 },
		});
		const loading = mountBrief({ brief, itemsState: 'loading' });
		expect(loading.find('[data-testid="brief-items-forYou-empty"]').exists()).toBe(false);
		expect(loading.get('[data-testid="brief-items-forYou-more"]').text()).toBe(
			'Loading the rest of the items…'
		);
		expect(loading.text()).toContain('1 open');
		expect(loading.text()).not.toContain('Nothing for you');

		const cut = mountBrief({ brief, itemsState: 'truncated' });
		expect(cut.get('[data-testid="brief-items-forYou-more"]').text()).toContain(
			'Not every item could be loaded here.'
		);
	});

	it('discloses a cut walk even when the loaded items are all proposals', () => {
		const proposals = Array.from({ length: 5 }, (_, i) =>
			item({ id: `p${i}`, text: `Maybe ${i}`, verify: 'proposal' })
		);
		const brief = briefView({
			forYou: proposals,
			counts: { forYou: 1, forTeam: 0, waitingOnOthers: 1, unclear: 0, closed: 0, hidden: 0 },
		});
		const w = mountBrief({ brief, itemsState: 'truncated' });
		// The one tracked obligation is not on screen: the list says so.
		expect(w.get('[data-testid="brief-items-forYou-more"]').text()).toContain(
			'Not every item could be loaded here.'
		);
		expect(w.get('[data-testid="brief-items-pagination"]').attributes('data-state')).toBe(
			'truncated'
		);
	});

	it('never gives the empty assurance before every page is in, and still discloses the cut', () => {
		const brief = briefView({
			forYou: [],
			counts: { forYou: 0, forTeam: 0, waitingOnOthers: 1, unclear: 0, closed: 0, hidden: 0 },
		});
		const w = mountBrief({ brief, itemsState: 'truncated' });
		expect(w.find('[data-testid="brief-items-forYou-empty"]').exists()).toBe(false);
		expect(w.get('[data-testid="brief-items-pagination"]').text()).toContain(
			'possibly including requests to check'
		);
		const complete = mountBrief({ brief });
		expect(complete.find('[data-testid="brief-items-pagination"]').exists()).toBe(false);
	});

	it('renders a pending amount with a malformed currency instead of failing', () => {
		const brief = briefView({
			forYou: [
				item({
					id: 'q',
					text: 'Approve the quote',
					pendingUpdate: { evidence: [], amount: { value: 5000, currency: '€' } },
				}),
			],
		});
		const pending = mountBrief({ brief }).get('[data-testid="brief-item-pending"]');
		expect(pending.text()).toContain('5,000 €');
	});

	it('heads each list with the maintained count, not the loaded one', () => {
		const brief = briefView({
			counts: { forYou: 7, forTeam: 0, waitingOnOthers: 1, unclear: 0, closed: 0, hidden: 0 },
		});
		const w = mountBrief({ brief, itemsState: 'loading' });
		expect(w.text()).toContain('7 open');
		expect(w.get('[data-testid="brief-items-forYou-more"]').exists()).toBe(true);
	});

	it('says there is nothing for you only when the brief is complete', () => {
		const w = mountBrief({ brief: briefView({ forYou: [] }) });
		expect(w.get('[data-testid="brief-items-forYou-empty"]').text()).toBe(
			'Nothing for you in this thread.'
		);
	});

	it('explains a missing overview and shows no blocks', () => {
		const w = mountBrief({
			brief: briefView({
				completeness: 'none',
				gap: { interpretedMessages: 0, totalMessages: 1, reason: 'aiOff' },
			}),
		});
		expect(w.get('[data-testid="brief-incomplete"]').attributes('data-kind')).toBe('none');
		expect(w.text()).toContain('AI is off');
		expect(w.find('[data-testid="brief-items-forYou"]').exists()).toBe(false);
	});

	it('shows a security mail as written', () => {
		const w = mountBrief({
			brief: briefView({
				latest: undefined,
				gap: { interpretedMessages: 1, totalMessages: 1, reason: 'security' },
			}),
		});
		expect(w.get('[data-testid="brief-incomplete"]').text()).toContain('Security email.');
	});

	it('Answer mode: checkboxes bound to the selection, no reactions', async () => {
		const w = mountBrief({ selectable: true, selected: ['i_quote'] });
		const boxes = w.findAll('[data-testid="brief-item-select"]');
		expect(boxes).toHaveLength(2);
		expect((boxes[0]!.element as HTMLInputElement).checked).toBe(true);
		await boxes[1]!.trigger('change');
		expect(w.emitted('update:selected')).toEqual([[['i_quote', 'i_contract']]]);
		expect(w.find('[data-testid="brief-item-primary"]').exists()).toBe(false);
	});

	it('folds the rest into one disclosure on a phone', async () => {
		const w = mountBrief({ compact: true });
		expect(w.find('[data-testid="brief-standing"]').exists()).toBe(false);
		expect(w.find('[data-testid="brief-activity"]').exists()).toBe(false);
		expect(w.find('[data-testid="brief-items-forYou"]').exists()).toBe(true);
		await w.get('[data-testid="brief-more"]').trigger('click');
		expect(w.find('[data-testid="brief-standing"]').exists()).toBe(true);
		expect(w.find('[data-testid="brief-activity"]').exists()).toBe(true);
	});

	it('shows a skeleton while loading', () => {
		const w = mountBrief({ brief: undefined });
		expect(w.get('[data-testid="thread-brief"]').attributes('aria-busy')).toBe('true');
	});
});
