// @vitest-environment happy-dom
/**
 * Team Inbox thread row (UX piece b2a) — renders the Postbox row DNA for a
 * team thread from a fixture:
 *   - unread → weight-based emphasis (font-semibold identifier) + the brand
 *     unread dot; read → recessive text, no dot (weight, never colour)
 *   - the ONE roll-up status chip (real InboxStatusChip / threadStatusChip)
 *   - a channel chip ONLY for non-email threads
 *   - the assignee avatar (name resolved) with a presence ring when present
 *   - the denormalized snippet line
 *
 * The shared PostboxRowCore and the real StatusChip render so slots + the chip
 * vocabulary are exercised; Icon / UiAvatar / NuxtLink are global auto-imports,
 * stubbed here (UiAvatar echoes its name so the assignee is assertable).
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';

import InboxThreadRow, { type InboxThreadRowThread } from '../InboxThreadRow.vue';
import PostboxRowCore from '../../postbox/PostboxRowCore.vue';
import StatusChip from '../StatusChip.vue';

const UiAvatarStub = {
	props: ['name', 'email', 'image'],
	template: '<span class="ui-avatar-stub">{{ name || email }}</span>',
};
const NuxtLinkStub = { props: ['to'], template: '<a :href="to"><slot /></a>' };
// The avatar picker is exercised in AssignPopover.test.ts; here it is stubbed to
// render its trigger slot plus a hook that fires the `assign` selection so we can
// assert the row forwards it.
const AssignPopoverStub = {
	props: ['members', 'currentUserId', 'assignedTo', 'open', 'position'],
	emits: ['assign', 'update:open'],
	template:
		'<div><slot name="trigger" /><button class="assign-pick" @click="$emit(\'assign\', \'picked-user\')" /></div>',
};

function mountRow(thread: Partial<InboxThreadRowThread>) {
	const full: InboxThreadRowThread = {
		_id: 't1',
		_creationTime: 1000,
		subject: 'Refund request',
		contactIdentifier: 'customer@example.com',
		status: 'open',
		lastMessageAt: 2000,
		...thread,
	};
	return mount(InboxThreadRow, {
		props: { thread: full, focused: false, formatCompactRelativeTime: () => '5m' },
		global: {
			components: { PostboxRowCore, InboxStatusChip: StatusChip },
			stubs: {
				Icon: true,
				UiAvatar: UiAvatarStub,
				NuxtLink: NuxtLinkStub,
				InboxAssignPopover: AssignPopoverStub,
			},
		},
	});
}

describe('InboxThreadRow', () => {
	it('renders an unread thread with weight-based emphasis, the status chip, assignee, and snippet', () => {
		const w = mountRow({
			unread: true,
			latestDraftStatus: 'pending',
			lastPreview: 'Hi, I would like a refund on order 123.',
			channel: 'email',
			assignee: { name: 'Jordan Lee', email: 'jordan@team.com' },
			assigneePresent: true,
		});

		// Subject + snippet.
		expect(w.text()).toContain('Refund request');
		expect(w.text()).toContain('Hi, I would like a refund on order 123.');

		// Weight, not colour: the identifier is semibold and the brand unread dot shows.
		expect(w.html()).toContain('font-semibold');
		expect(w.find('.bg-brand').exists()).toBe(true);

		// The single roll-up status chip (real vocabulary): a pending draft reads "Draft ready".
		expect(w.text()).toContain('Draft ready');

		// Assignee avatar (name echoed) + live presence ring.
		expect(w.text()).toContain('Jordan Lee');
		expect(w.find('.ui-presence-ring').exists()).toBe(true);

		// Email channel → NO channel chip.
		expect(w.text()).not.toContain('SMS');
	});

	it('renders a read non-email thread: recessive text, no unread dot, a channel chip, no assignee', () => {
		const w = mountRow({
			unread: false,
			channel: 'sms',
			lastPreview: 'thanks!',
			assignee: null,
		});

		// No brand unread dot; identifier recessive (not emphasised).
		expect(w.find('.bg-brand').exists()).toBe(false);
		expect(w.html()).toContain('text-text-secondary');

		// Non-email → one channel chip.
		expect(w.text()).toContain('SMS');

		// Unassigned → no avatar, no presence ring.
		expect(w.find('.ui-avatar-stub').exists()).toBe(false);
		expect(w.find('.ui-presence-ring').exists()).toBe(false);
	});

	it('emits triage intents from the hover quick actions', async () => {
		const w = mountRow({ unread: true });
		// Assign is forwarded from the picker's selection (carrying the chosen id).
		await w.get('.assign-pick').trigger('click');
		await w.get('[aria-label="Resolve"]').trigger('click');
		await w.get('[aria-label="Snooze"]').trigger('click');
		expect(w.emitted('assign')).toEqual([['picked-user']]);
		expect(w.emitted('resolve')).toHaveLength(1);
		expect(w.emitted('snooze')).toHaveLength(1);
	});
});
