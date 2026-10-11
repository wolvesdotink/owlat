// @vitest-environment happy-dom
/**
 * The team thread stream (plan §4.3): every internal note says "Internal"; a
 * team reply shows who sent it to whom and keeps a queued or failed state;
 * what happened reads as system lines; a host renders the emails through its
 * slot; and a note's reactions and linked action show and toggle.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { defineComponent, h } from 'vue';
import { mount } from '@vue/test-utils';
import TeamThreadStream from '../TeamThreadStream.vue';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';
import { activity, email, note, reply, T0 } from '~/utils/__tests__/teamStreamFixtures';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n, useRoute: () => ({ hash: '' }) });
});

const Plain = defineComponent({ setup: () => () => h('span') });
const MIN = 60_000;

function mountStream(props: Record<string, unknown>, slots: Record<string, unknown> = {}) {
	return mount(TeamThreadStream, {
		props: { memberName: (id: string) => (id === 'user_mika' ? 'Mika' : 'Jule'), ...props },
		slots: slots as never,
		global: {
			plugins: [createTestI18n()],
			components: {
				UiAvatar: Plain,
				UiButton: defineComponent({
					setup:
						(_, { slots: s }) =>
						() =>
							h('button', s['default']?.()),
				}),
				InboxNoteComposer: Plain,
				InboxAutoSendCountdown: defineComponent({
					props: { sendAt: { type: Number, required: true } },
					emits: ['cancel'],
					setup:
						(props, { emit }) =>
						() =>
							h('button', {
								'data-testid': 'countdown',
								'data-send-at': props.sendAt,
								onClick: () => emit('cancel'),
							}),
				}),
			},
			stubs: { Icon: true },
		},
	});
}

describe('TeamThreadStream', () => {
	it('labels every note Internal and every reply with its sender and recipient', () => {
		const w = mountStream({
			entries: [
				email('e1', T0),
				note('n1', T0 + MIN),
				reply('r1', T0 + 2 * MIN),
				reply('r2', T0 + 3 * MIN, { isAgent: true, status: 'queued', authorUserId: undefined }),
				reply('r3', T0 + 4 * MIN, { status: 'failed', errorMessage: 'Mailbox full' }),
			],
		});
		const notes = w.findAll('[data-testid="team-stream-note"]');
		expect(notes).toHaveLength(1);
		expect(notes[0]!.find('[data-testid="team-note-internal"]').text()).toBe('Internal');
		const replies = w.findAll('[data-testid="team-stream-reply"]');
		expect(replies[0]!.text()).toContain('Mika → Ana Costa');
		expect(replies[1]!.text()).toContain('The agent → Ana Costa');
		expect(replies[1]!.find('[data-testid="team-reply-status"]').text()).toBe('Sending');
		expect(replies[2]!.attributes('data-status')).toBe('failed');
		expect(replies[2]!.text()).toContain('Mailbox full');
		// The default email bubble shows the original's first lines, never a summary.
		expect(w.find('[data-testid="team-stream-email"]').text()).toContain(
			'Hi, my lamp arrived broken.'
		);
		expectFullyLocalized(w);
	});

	it('renders what happened as system lines and groups new actions', () => {
		const w = mountStream({
			entries: [
				email('e1', T0),
				activity('a1', T0 + 1000, 'item_opened', { itemText: 'Refund €129.00' }),
				activity('a2', T0 + 2000, 'item_opened', { itemText: 'Return the lamps?' }),
				activity('a3', T0 + 3 * MIN, 'send_held'),
			],
		});
		const lines = w.findAll('[data-testid="team-stream-system"]');
		expect(lines.map((l) => l.attributes('data-type'))).toEqual(['item_opened', 'send_held']);
		expect(lines[0]!.text()).toContain('2 new actions for the team');
		expect(lines[1]!.text()).toContain('A reply was held for review.');
		expect(lines[1]!.find('[data-testid="team-stream-provenance"]').text()).toBe('recorded');
	});

	it('hands customer emails to the host through its slot', () => {
		const w = mountStream(
			{ entries: [email('e1', T0)] },
			{ email: ({ entry }: { entry: { key: string } }) => h('div', { class: 'host' }, entry.key) }
		);
		expect(w.find('.host').text()).toBe('email:e1');
		expect(w.find('[data-testid="team-stream-email"]').exists()).toBe(false);
	});

	it('shows the linked action and the reactions, and toggles one', async () => {
		const w = mountStream({
			entries: [
				note('n1', T0, {
					threadItemId: 'i_refund' as never,
					threadItemText: 'Refund €129.00',
					body: '@mika refund is fine',
					reactions: [{ emoji: '👍', count: 1, isMine: false }],
				}),
			],
		});
		expect(w.find('[data-testid="team-note-item"]').text()).toBe('on Refund €129.00');
		const reactions = w.find('[data-testid="team-note-reactions"]');
		await reactions.findAll('button')[0]!.trigger('click');
		expect(w.emitted('react-note')?.[0]?.[1]).toBe('👍');
		await w.find('[data-testid="team-note-add-reaction"]').trigger('click');
		await w.find('[role="menu"] button').trigger('click');
		expect(w.emitted('react-note')?.[1]?.[1]).toBe('👍');
	});

	it('counts a follow-up down to its send time, with Undo', async () => {
		const sendAt = T0 + 5 * MIN;
		const w = mountStream({
			entries: [reply('f1', T0, { status: 'queued', followUpId: 'fu_1' as never, sendAt })],
		});
		const countdown = w.get('[data-testid="team-reply-undo"]');
		expect(countdown.attributes('data-send-at')).toBe(String(sendAt));
		await countdown.trigger('click');
		expect(w.emitted('undo-follow-up')?.[0]?.[0]).toMatchObject({ followUpId: 'fu_1' });
	});

	it('offers older entries when there are some', async () => {
		const w = mountStream({ entries: [email('e1', T0)], hasEarlier: true });
		await w.find('[data-testid="team-stream-earlier"]').trigger('click');
		expect(w.emitted('load-earlier')).toHaveLength(1);
	});
});
