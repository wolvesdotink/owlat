// @vitest-environment happy-dom
/**
 * "Open for the team" (plan §4.3): each action names its owner or says
 * Unassigned; an unassigned one offers Claim, an owned one its reaction;
 * assigning goes through the menu; what the customer owes and what nobody
 * can tell who owns stay visible below; it never says "nothing open" while
 * the emails are not fully read, and folds into one line on a phone.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { defineComponent, h } from 'vue';
import { mount } from '@vue/test-utils';
import TeamOpenItems from '../TeamOpenItems.vue';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';
import { item, teamView } from '~/utils/__tests__/teamStreamFixtures';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n, useLocalized: () => (s: string) => s });
});

const Plain = defineComponent({ setup: () => () => h('span') });
const MenuStub = defineComponent({
	setup:
		(_, { slots }) =>
		() =>
			h('div', { 'data-testid': 'item-menu' }, slots['default']?.({ close: () => {} })),
});
const Button = defineComponent({
	emits: ['click'],
	setup:
		(_, { slots, emit, attrs }) =>
		() =>
			h('button', { ...attrs, onClick: () => emit('click') }, slots['default']?.()),
});

const MEMBERS = [
	{ userId: 'user_mika', name: 'Mika', email: 'mika@northwind.example', image: null },
	{ userId: 'user_jule', name: 'Jule', email: 'jule@northwind.example', image: null },
	{ userId: 'me', name: 'Ada', email: 'ada@northwind.example', image: null },
];

function mountItems(props: Record<string, unknown> = {}) {
	return mount(TeamOpenItems, {
		props: { view: teamView(), viewerId: 'me', members: MEMBERS, ...props },
		global: {
			plugins: [createTestI18n()],
			components: {
				UiAvatar: Plain,
				UiButton: Button,
				PostboxOverflowMenu: MenuStub,
				BriefIncomplete: Plain,
			},
			stubs: { Icon: true },
		},
	});
}

describe('TeamOpenItems', () => {
	it('names the owner or Unassigned, with Claim on the unassigned action', async () => {
		const w = mountItems({ noteCounts: new Map([['i_refund', 2]]) });
		const [refund, unassigned] = w.findAll('[data-testid="team-open-item"]');
		expect(refund!.find('[data-testid="team-item-assignee"]').text()).toBe('Mika');
		expect(refund!.find('[data-testid="team-item-notes"]').text()).toBe('2 notes');
		expect(refund!.find('[data-testid="team-item-primary"]').text()).toBe('Reply');
		expect(unassigned!.find('[data-testid="team-item-assignee"]').text()).toBe('Unassigned');
		const claim = unassigned!.find('[data-testid="team-item-primary"]');
		expect(claim.text()).toBe('Claim');
		await claim.trigger('click');
		expect(w.emitted('act')?.[0]?.[1]).toBe('claim');
		expect(w.text()).toContain('Open for the team');
		expectFullyLocalized(w);
	});

	it('assigns through the menu and hands an action back to Unassigned', async () => {
		const w = mountItems();
		const refund = w.findAll('[data-testid="team-open-item"]')[0]!;
		const assign = refund.findAll('[data-testid="team-item-assign"]');
		expect(assign.map((b) => b.text())).toEqual(['Jule', 'Me']);
		await assign[1]!.trigger('click');
		await refund.find('[data-testid="team-item-unassign"]').trigger('click');
		expect(w.emitted('assign')?.map((e) => e[1])).toEqual(['me', null]);
	});

	it('keeps what the customer owes and what nobody owns below, with the doubt said', () => {
		const w = mountItems({
			view: teamView({
				unclear: [item({ id: 'u1', text: 'Who pays the courier?', responsibility: 'unclear' })],
				waitingOnOthers: [
					item({
						id: 'w1',
						text: 'Ana sends photos',
						responsibility: 'them',
						primaryReaction: 'nudge',
					}),
				],
				counts: { forYou: 0, forTeam: 2, waitingOnOthers: 1, unclear: 1, closed: 0, hidden: 0 },
			}),
		});
		expect(w.find('[data-testid="team-open-items-unclear"]').text()).toContain(
			'unclear who should do this'
		);
		const waiting = w.find('[data-testid="team-open-items-waiting"]');
		expect(waiting.text()).toContain('Ana sends photos');
		expect(waiting.find('[data-testid="team-item-assignee"]').exists()).toBe(false);
		expect(w.text()).toContain('Waiting on the customer');
	});

	it('says nothing is open only when the emails were fully read', () => {
		const empty = {
			forTeam: [],
			counts: { forYou: 0, forTeam: 0, waitingOnOthers: 0, unclear: 0, closed: 0, hidden: 0 },
		};
		const done = mountItems({ view: teamView(empty) });
		expect(done.find('[data-testid="team-open-items-empty"]').exists()).toBe(true);
		const partial = mountItems({ view: teamView({ ...empty, completeness: 'partial' }) });
		expect(partial.find('[data-testid="team-open-items-empty"]').exists()).toBe(false);
		const none = mountItems({ view: teamView({ ...empty, completeness: 'none' }) });
		expect(none.find('[data-testid="team-open-items"]').exists()).toBe(false);
	});

	it('offers to confirm when a later message may have settled an action', async () => {
		const settled = item({
			id: 'i_s',
			text: 'Send the invoice',
			assigneeUserId: 'user_mika',
			pendingUpdate: { evidence: [], transitions: [{ to: 'done', at: 1 }] },
		});
		const w = mountItems({ view: teamView({ forTeam: [settled] }) });
		const pending = w.get('[data-testid="brief-item-pending"]');
		expect(pending.text()).toContain('A later message may have settled this');
		await pending.get('[data-testid="brief-item-pending-confirm"]').trigger('click');
		expect(pending.get('[data-testid="brief-item-pending-confirm"]').text()).toBe('Confirm');
		expect(w.emitted('act')?.[0]?.[1]).toBe('confirmProposal');
		expectFullyLocalized(w);
	});

	it('lists an action closed by a confirmation under "Just closed", with Undo', async () => {
		const closed = item({
			id: 'i_c',
			text: 'Refund €129.00',
			status: 'done',
			stateKey: 'reportedDone',
			correction: { kind: 'confirmed', at: 1 },
		});
		const w = mountItems({ view: teamView({ forTeam: [closed] }) });
		const list = w.get('[data-testid="team-open-items-closed"]');
		expect(w.text()).toContain('Just closed');
		const undo = list.get('[data-testid="team-item-primary"]');
		expect(undo.text()).toBe('Undo');
		await undo.trigger('click');
		expect(w.emitted('act')?.[0]?.[1]).toBe('undo');
	});

	it('folds into "2 open for the team" on a phone', async () => {
		const w = mountItems();
		const toggle = w.find('[data-testid="team-open-items-toggle"]');
		expect(toggle.text()).toContain('2 open for the team');
		expect(toggle.attributes('aria-expanded')).toBe('false');
		await toggle.trigger('click');
		expect(toggle.attributes('aria-expanded')).toBe('true');
	});
});
