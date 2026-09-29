// @vitest-environment happy-dom
/**
 * The sidebar's inbox groups re-key their thread query on every collapse,
 * expand and per-inbox count change. They keep the rows and the status dot on
 * screen until the new list lands instead of blinking out (plan 1.6). Runs the
 * real `useConvexQuery` over a fake client, so the option is exercised, not
 * just passed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { useConvexQuery } from '~/composables/useConvexQuery';
import InboxGroup from '../InboxGroup.vue';
import TeamInboxGroup from '../TeamInboxGroup.vue';

let client: { onUpdate: ReturnType<typeof vi.fn> };
/** The latest subscription's delivery callback, per call. */
let deliveries: Array<(value: unknown) => void>;

beforeEach(() => {
	deliveries = [];
	client = {
		onUpdate: vi.fn((_query: unknown, _args: unknown, onUpdate: (value: unknown) => void) => {
			deliveries.push(onUpdate);
			return vi.fn();
		}),
	};
	Object.assign(globalThis, {
		useI18n: i18nStubs.useI18n,
		useRoute: () => ({ path: '/dashboard' }),
		useConvex: () => client,
		useConvexQuery,
	});
});

const global = {
	plugins: [createTestI18n()],
	components: {
		NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
		ShellThreadRow: { props: ['title'], template: '<div class="row">{{ title }}</div>' },
		ShellStatusPill: {
			props: ['status'],
			template: '<span class="pill" :data-status="status" />',
		},
	},
	stubs: { Icon: true, InboxChip: true },
	// A template-level auto-import.
	mocks: { formatCompactRelativeTime: () => 'now' },
};

const inbox = {
	mailboxId: 'mailbox-1',
	name: 'Support',
	address: 'support@owlat.example',
	slot: 0,
	unread: 0,
	scope: 'team',
};

const thread = (id: string) => ({
	threadId: id,
	latestMessageId: `m-${id}`,
	subject: `Thread ${id}`,
	lastMessageAt: 1,
	status: 'needs_reply',
	isUnread: false,
});

describe('ShellInboxGroup', () => {
	it('keeps its rows while a new count loads, and its dot while collapsing', async () => {
		const wrapper = mount(InboxGroup, {
			props: { inbox, limit: 5, sort: 'recent', collapsed: false },
			global,
		});
		deliveries.at(-1)!({
			threads: [thread('a'), thread('b')],
			groupStatus: 'needs_reply',
			hiddenStatus: null,
		});
		await nextTick();
		expect(wrapper.findAll('.row')).toHaveLength(2);

		await wrapper.setProps({ limit: 10 });
		expect(client.onUpdate).toHaveBeenCalledTimes(2);
		expect(wrapper.findAll('.row').map((row) => row.text())).toEqual(['Thread a', 'Thread b']);

		await wrapper.setProps({ collapsed: true });
		expect(client.onUpdate).toHaveBeenCalledTimes(3);
		expect(wrapper.find('.pill').attributes('data-status')).toBe('needs_reply');
	});
});

describe('ShellTeamInboxGroup', () => {
	it('keeps its rows while a new count loads', async () => {
		const wrapper = mount(TeamInboxGroup, {
			props: { limit: 5, sort: 'recent', collapsed: false },
			global,
		});
		// Call order: the thread list, then the inbound stats.
		deliveries[0]!({
			threads: [
				{
					_id: 'a',
					subject: 'Refund',
					lastMessageAt: 1,
					unread: false,
					status: 'open',
				},
			],
		});
		await nextTick();
		expect(wrapper.findAll('.row')).toHaveLength(1);

		await wrapper.setProps({ limit: 10 });
		expect(wrapper.findAll('.row').map((row) => row.text())).toEqual(['Refund']);
	});
});
