/**
 * An unread row marks itself and nothing more: the dot before the sender, the
 * weight marker on the sender and subject, and "Unread." spoken before the
 * sender. Which of those cues show is decided by the Postbox root's
 * `data-unread-style` in postbox-unread.css (pinned in postboxUnreadStyle.test).
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import PostboxThreadRowBody from '../PostboxThreadRowBody.vue';
import PostboxConversationRow from '../PostboxConversationRow.vue';
import PostboxRowCore from '../PostboxRowCore.vue';
import PostboxUnreadMark from '../PostboxUnreadMark.vue';
import { POSTBOX_PRIORITY_ROWS } from '~/utils/postboxPriorityGroups';

vi.mock('~/composables/postbox/usePostboxListClock', () => ({
	usePostboxThreadTimestamp: () => () => '09:12',
}));
vi.mock('~/composables/useLocalized', () => ({ useLocalized: () => (text: string) => text }));

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

const components = { PostboxRowCore, PostboxUnreadMark };
const stubs = { PostboxThreadRowFollowUp: true, Icon: true };

function mountRow(msg: Record<string, unknown>, opts: { priority?: boolean } = {}) {
	return mount(PostboxThreadRowBody, {
		props: {
			msg: {
				_id: 'm1',
				fromAddress: 'ben@example.com',
				fromName: 'Ben Ortiz',
				subject: 'Invoice #2041',
				snippet: 'Attached is the invoice',
				receivedAt: Date.UTC(2026, 9, 17, 9),
				flagSeen: false,
				flagFlagged: false,
				...msg,
			} as never,
		},
		global: {
			plugins: [createTestI18n()],
			components,
			provide: opts.priority ? { [POSTBOX_PRIORITY_ROWS as symbol]: true } : {},
			stubs,
		},
	});
}

describe('PostboxThreadRowBody unread marking', () => {
	it('leads an unread row with the dot and says "Unread." before the sender', () => {
		const w = mountRow({});
		expect(w.findAll('.pbx-unread-dot')).toHaveLength(1);
		expect(w.get('.pbx-unread-dot').attributes('aria-hidden')).toBe('true');
		expect(w.text()).toMatch(/^Unread\. Ben Ortiz/);
		const weighted = w.findAll('.pbx-unread-weight').map((el) => el.text());
		expect(weighted).toEqual([expect.stringContaining('Ben Ortiz'), 'Invoice #2041']);
	});

	it('marks nothing on a read row', () => {
		const w = mountRow({ flagSeen: true });
		expect(w.find('.pbx-unread-dot').exists()).toBe(false);
		expect(w.find('.pbx-unread-weight').exists()).toBe(false);
		expect(w.text()).not.toContain('Unread');
	});

	it('marks the one-line Priority row the same way', () => {
		const w = mountRow({ placement: 'today' }, { priority: true });
		expect(w.findAll('.pbx-unread-dot')).toHaveLength(1);
		expect(w.get('[data-testid="priority-row"]').text()).toMatch(/^Unread\. Ben Ortiz/);
		expect(w.find('.pbx-unread-weight').exists()).toBe(true);

		const read = mountRow({ placement: 'today', flagSeen: true }, { priority: true });
		expect(read.find('.pbx-unread-dot').exists()).toBe(false);
	});
});

describe('PostboxConversationRow unread marking', () => {
	function mountConversation(unreadCount: number) {
		return mount(PostboxConversationRow, {
			props: {
				thread: {
					_id: 't1',
					latestFromAddress: 'ben@example.com',
					latestSubject: 'Invoice #2041',
					latestSnippet: 'Attached is the invoice',
					lastMessageAt: Date.UTC(2026, 9, 17, 9),
					messageCount: 2,
					unreadCount,
					hasFlagged: false,
					hasAttachments: false,
				},
				domId: 'row-t1',
				to: '/dashboard/postbox/inbox/m1',
				selected: false,
			},
			global: {
				plugins: [createTestI18n()],
				components,
				directives: { replyDrop: {} },
				stubs: { ...stubs, NuxtLink: { template: '<a><slot /></a>' } },
			},
		});
	}

	it('shows the dot and the weight marker but leaves the name to its aria-label', () => {
		const w = mountConversation(1);
		expect(w.findAll('.pbx-unread-dot')).toHaveLength(1);
		expect(w.findAll('.pbx-unread-weight')).toHaveLength(2);
		// The row's aria-label already says how many are unread.
		expect(w.text()).not.toContain('Unread.');
	});

	it('marks nothing once the conversation is read', () => {
		const w = mountConversation(0);
		expect(w.find('.pbx-unread-dot').exists()).toBe(false);
		expect(w.find('.pbx-unread-weight').exists()).toBe(false);
	});
});
