/**
 * The purpose header an opened conversation leads with:
 *   - an ask: the item's words with its source marker, whose turn it is, the
 *     due date, "2 more" revealing the other open items, and Reply, Make task
 *     tied to the item, and Done;
 *   - an item the brief only proposes offers Track and Not a request instead;
 *   - an update: the latest line with Got it, then "Marked as seen";
 *   - review (AI off, no brief): "Review this conversation" over the subject,
 *     with Reply and Make task, never a claim that nothing is to do;
 *   - a team surface: "Open for the team" with Claim, a teammate's hold by
 *     name, and the host's full list behind "more";
 *   - while the brief loads, the subject leads.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import BriefPurposeHeader from '../BriefPurposeHeader.vue';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';
import { briefView, item, T0 } from '~/utils/__tests__/threadBriefFixtures';
import { teamView } from '~/utils/__tests__/teamStreamFixtures';
import { resolveThreadPurpose } from '~/utils/threadPurpose';

const popoverProps = vi.fn();
vi.mock('~/components/tasks/TaskCreatePopover.vue', () => ({
	default: defineComponent({
		name: 'TaskCreatePopover',
		inheritAttrs: false,
		setup(_props, { attrs }) {
			return () => {
				popoverProps({ ...attrs });
				return h('button', { 'data-testid': 'task-create-trigger' }, 'Make task');
			};
		},
	}),
}));

vi.mock('~/composables/useShortcutLabels', () => ({
	useShortcutLabels: () => ({ ariaFor: () => 'R' }),
}));

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

beforeEach(() => {
	popoverProps.mockClear();
});

const ShortcutStub = defineComponent({ setup: () => () => h('kbd', 'R') });

function mountHeader(props: Record<string, unknown>, slots: Record<string, () => unknown> = {}) {
	return mount(BriefPurposeHeader, {
		props: props as never,
		slots: slots as never,
		global: { plugins: [createTestI18n()], components: { UiShortcut: ShortcutStub } },
	});
}

const SOURCES = { m6: { name: 'Jonas Weber', email: 'jonas@kestrel.example', at: T0 } };

describe('BriefPurposeHeader', () => {
	it('leads with the ask, its turn, due date and the others behind "2 more"', async () => {
		const cite = vi.fn();
		const purpose = resolveThreadPurpose({ isAiOn: true, brief: briefView() });
		const w = mountHeader({
			purpose,
			subject: 'Website relaunch',
			messageCount: 6,
			mailThreadId: 't1',
			sourceOf: (id: string) => SOURCES[id as 'm6'],
			cite,
			replyShortcut: 'postbox.reply',
			headingTag: 'h1',
		});

		const heading = w.get('h1[data-testid="purpose-sentence"]');
		expect(heading.text()).toContain('Approve the revised quote of €5,350');
		expect(w.get('[data-testid="purpose-subject"]').text()).toBe('Website relaunch · 6 messages');
		expect(w.get('[data-testid="purpose-who"]').text()).toBe('For you');
		expect(w.get('[data-testid="purpose-due"]').text()).toMatch(/^Due /);

		await heading.get('[data-testid="evidence-marker"]').trigger('click');
		expect(cite).toHaveBeenCalledWith('i_quote', 0);

		const more = w.get('[data-testid="purpose-more"]');
		expect(more.text()).toBe('2 more');
		expect(more.attributes('aria-expanded')).toBe('false');
		const list = w.get(`[id="${more.attributes('aria-controls')}"]`);
		expect((list.element as HTMLElement).style.display).toBe('none');
		await more.trigger('click');
		expect(more.attributes('aria-expanded')).toBe('true');
		expect((list.element as HTMLElement).style.display).toBe('');
		expect(w.findAll('[data-testid="purpose-other"]').map((li) => li.text())).toEqual([
			expect.stringContaining('For you:\u00a0Send the signed contract as a PDF'),
			expect.stringContaining('Waiting on them:\u00a0Jonas sends the new hero photos'),
		]);

		await w.get('[data-testid="purpose-reply"]').trigger('click');
		expect(w.emitted('reply')).toHaveLength(1);
		expect(w.get('[data-testid="purpose-reply"]').attributes('aria-keyshortcuts')).toBe('R');
		await w.get('[data-testid="purpose-markDone"]').trigger('click');
		expect(w.emitted('act')).toEqual([[purpose.item, 'markDone']]);
		expect(w.get('[data-testid="purpose-markDone"]').text()).toBe('Done');
		expect(popoverProps).toHaveBeenLastCalledWith(
			expect.objectContaining({
				'mail-thread-id': 't1',
				'thread-item-id': 'i_quote',
				'default-title': 'Approve the revised quote of €5,350',
			})
		);
		expectFullyLocalized(w);
	});

	it('says how many more the unloaded pages hold', async () => {
		const brief = briefView();
		const purpose = resolveThreadPurpose({
			isAiOn: true,
			brief: { ...brief, counts: { ...brief.counts, forYou: 5 } },
		});
		const w = mountHeader({ purpose });
		await w.get('[data-testid="purpose-more"]').trigger('click');
		expect(w.get('[data-testid="purpose-more"]').text()).toBe('5 more');
		expect(w.get('[data-testid="purpose-unlisted"]').text()).toBe('3 more in the full brief');
	});

	it('offers Track and Not a request on an item the brief only proposes', () => {
		const purpose = resolveThreadPurpose({
			isAiOn: true,
			brief: briefView({
				forYou: [item({ id: 'p', text: 'Book the venue', verify: 'proposal' })],
				waitingOnOthers: [],
				counts: { forYou: 1, forTeam: 0, waitingOnOthers: 0, unclear: 0, closed: 0, hidden: 0 },
			}),
		});
		const w = mountHeader({ purpose });
		expect(w.get('[data-testid="purpose-sentence"]').text()).toBe('Check this: Book the venue');
		expect(w.find('[data-testid="purpose-markDone"]').exists()).toBe(false);
		expect(w.get('[data-testid="purpose-confirmProposal"]').text()).toBe('Track');
		expect(w.find('[data-testid="purpose-notARequest"]').exists()).toBe(true);
		expect(w.find('[data-testid="purpose-more"]').exists()).toBe(false);
	});

	it('leads an update with its latest line and Got it', async () => {
		const purpose = resolveThreadPurpose({
			isAiOn: true,
			brief: briefView({
				forYou: [],
				waitingOnOthers: [],
				counts: { forYou: 0, forTeam: 0, waitingOnOthers: 0, unclear: 0, closed: 0, hidden: 0 },
			}),
		});
		const w = mountHeader({ purpose, subject: 'Website relaunch' });
		expect(w.get('[data-testid="purpose-header"]').attributes('data-kind')).toBe('update');
		expect(w.get('[data-testid="purpose-sentence"]').text()).toBe(
			'Jonas likes design v2 and wants two changes.'
		);
		expect(w.find('[data-testid="purpose-who"]').exists()).toBe(false);
		await w.get('[data-testid="purpose-got-it"]').trigger('click');
		expect(w.emitted('got-it')).toHaveLength(1);

		await w.setProps({ acknowledged: true });
		expect(w.find('[data-testid="purpose-got-it"]').exists()).toBe(false);
		expect(w.get('[data-testid="purpose-seen"]').text()).toBe('Marked as seen');
	});

	it('asks for a review with AI off, the subject under it, Reply and Make task', () => {
		const purpose = resolveThreadPurpose({ isAiOn: false, brief: briefView() });
		const w = mountHeader({ purpose, subject: 'Website relaunch', mailThreadId: 't1' });
		expect(w.get('[data-testid="purpose-header"]').attributes('data-kind')).toBe('review');
		expect(w.get('[data-testid="purpose-sentence"]').text()).toBe('Review this conversation');
		expect(w.get('[data-testid="purpose-subject"]').text()).toBe('Website relaunch');
		expect(w.find('[data-testid="evidence-marker"]').exists()).toBe(false);
		expect(w.find('[data-testid="purpose-who"]').exists()).toBe(false);
		expect(w.find('[data-testid="purpose-reply"]').exists()).toBe(true);
		expect(w.find('[data-testid="task-create-trigger"]').exists()).toBe(true);
		expect(w.find('[data-testid="purpose-markDone"]').exists()).toBe(false);
		expect(w.text()).not.toMatch(/nothing/i);
		expect(popoverProps).toHaveBeenLastCalledWith(
			expect.objectContaining({ 'mail-thread-id': 't1', 'default-title': '' })
		);
	});

	it('lets the subject lead while the brief loads', () => {
		const purpose = resolveThreadPurpose({ isAiOn: true, brief: undefined });
		const w = mountHeader({ purpose, subject: 'Website relaunch', messageCount: 2, pending: true });
		expect(w.get('[data-testid="purpose-sentence"]').text()).toBe('Website relaunch');
		expect(w.get('[data-testid="purpose-subject"]').text()).toBe('2 messages');
	});

	it('on a team surface: open for the team with Claim, and the full list behind "more"', async () => {
		const view = teamView();
		const unassigned = resolveThreadPurpose({
			isAiOn: true,
			team: teamView({ forTeam: [view.forTeam[1]!], counts: { ...view.counts, forTeam: 1 } }),
			viewerId: 'user_ada',
		});
		const w = mountHeader(
			{ purpose: unassigned, conversationThreadId: 'th1', alwaysOfferMore: true },
			{ more: () => h('div', { 'data-testid': 'team-list' }, 'All open items') }
		);
		expect(w.get('[data-testid="purpose-who"]').text()).toBe('Open for the team');
		expect(w.get('[data-testid="purpose-claim"]').text()).toBe('Claim');
		await w.get('[data-testid="purpose-claim"]').trigger('click');
		expect(w.emitted('act')).toEqual([[unassigned.item, 'claim']]);
		const more = w.get('[data-testid="purpose-more"]');
		expect(more.text()).toBe('Owner and notes');
		await more.trigger('click');
		expect(w.get('[data-testid="team-list"]').isVisible()).toBe(true);
		expect(popoverProps).toHaveBeenLastCalledWith(
			expect.objectContaining({ 'conversation-thread-id': 'th1', 'thread-item-id': 'i_return' })
		);

		const held = resolveThreadPurpose({ isAiOn: true, team: view, viewerId: 'user_ada' });
		const other = mountHeader({ purpose: held, memberName: () => 'Mika' });
		expect(other.get('[data-testid="purpose-who"]').text()).toBe('Mika has it');
		expect(other.find('[data-testid="purpose-claim"]').exists()).toBe(false);
		expect(other.get('[data-testid="purpose-more"]').text()).toBe('1 more');
	});

	it('shows no due date the brief could not resolve', () => {
		const purpose = resolveThreadPurpose({
			isAiOn: true,
			brief: briefView({
				forYou: [
					item({
						id: 'x',
						text: 'Send the deck',
						due: { phrase: 'soon', isAmbiguous: true },
					}),
				],
			}),
		});
		const w = mountHeader({ purpose });
		expect(purpose.due).toBeNull();
		expect(w.find('[data-testid="purpose-due"]').exists()).toBe(false);
	});
});
