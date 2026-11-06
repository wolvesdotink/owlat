/**
 * Dropping dragged Postbox rows on an inbox in the sidebar moves them into that
 * mailbox, or copies them with Shift held. The drop runs the move picker's own
 * transfer (team inbox confirmation, refusals, undo), so what is pinned here is
 * the hand-off: which drags an inbox takes, which mode it asks for, and that a
 * landed move spends the selection it carried.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick, ref } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { usePostboxMessageDrag } from '~/composables/postbox/usePostboxMessageDrag';
import ConversationsNav from '../ConversationsNav.vue';
import InboxGroup from '../InboxGroup.vue';

const confirmTarget = vi.fn(async (_id: string) => true);
const transfer = vi.fn(async (_ids: string[], _target: string, _mode: string) => true);
const transferSources: string[] = [];
vi.mock('~/composables/postbox/usePostboxMailboxTransfer', () => ({
	usePostboxMailboxTransfer: (mailboxId: () => string) => ({
		confirmTarget,
		transfer: (ids: string[], target: string, mode: string) => {
			transferSources.push(mailboxId());
			return transfer(ids, target, mode);
		},
	}),
}));

const inboxes = [
	{
		mailboxId: 'mb_dev',
		name: 'Dev',
		address: 'dev@owlat.dev',
		scope: 'personal',
		slot: 0,
		unread: 0,
	},
	{
		mailboxId: 'mb_team',
		name: 'Team',
		address: 'team@owlat.dev',
		scope: 'shared',
		slot: 1,
		unread: 0,
	},
];

beforeEach(() => {
	confirmTarget.mockClear();
	transfer.mockClear();
	transferSources.length = 0;
	Object.assign(globalThis, {
		useI18n: i18nStubs.useI18n,
		useRoute: () => ({ path: '/dashboard/postbox/inbox', query: {} }),
		useFeatureFlag: () => ({ isEnabled: () => false }),
		usePermissions: () => ({ isAdmin: ref(false), isRoleLoading: ref(false) }),
		useInboxes: () => ({ inboxes: ref(inboxes), hasPersonalMail: ref(true) }),
		usePostboxActiveMailbox: () => ({ activeMailboxId: ref('mb_dev') }),
		useAnswerQueueCount: () => ({ count: ref(0) }),
		useShellSidebarPrefs: () => ({
			perInbox: ref(5),
			sort: ref('recent'),
			isCollapsed: () => true,
			toggleGroup: () => undefined,
		}),
		useConvexQuery: () => ({ data: ref(null) }),
	});
});

afterEach(() => usePostboxMessageDrag().end());

function mountNav(collapsed: boolean) {
	return mount(ConversationsNav, {
		props: { collapsed, extraItems: [] },
		global: {
			plugins: [createTestI18n()],
			components: {
				NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
				ShellInboxGroup: InboxGroup,
			},
			stubs: {
				UiTooltip: { template: '<div><slot /></div>' },
				InboxChip: true,
				ShellStatusPill: true,
				ShellSidebarOptions: true,
				ShellThreadRow: true,
				ShellTeamInboxGroup: true,
				ShellChatGroup: true,
				UiSkeleton: true,
			},
		},
	});
}

/** Start a list drag of `messageIds` out of `mailboxId`; `spent` is the selection clear. */
function startDrag(
	messageIds: string[],
	opts: { mailboxId?: string; pinOnly?: boolean; spent?: () => void } = {}
) {
	usePostboxMessageDrag().start(
		{ dataTransfer: { setData: vi.fn(), setDragImage: vi.fn() } } as unknown as DragEvent,
		{
			mailboxId: (opts.mailboxId ?? 'mb_dev') as never,
			messageIds: messageIds as never,
			sourceFolder: 'inbox',
			moveTo: opts.pinOnly ? null : vi.fn(async () => {}),
			...(opts.spent ? { spent: opts.spent } : {}),
		},
		'Subject'
	);
}

/** Dispatch a cancelable drag event; `true` means the target claimed it. */
function fire(el: Element, type: string, shiftKey = false) {
	const event = new Event(type, { bubbles: true, cancelable: true });
	Object.defineProperty(event, 'shiftKey', { value: shiftKey });
	el.dispatchEvent(event);
	return event.defaultPrevented;
}

const railEntry = (w: ReturnType<typeof mountNav>, mailboxId: string) =>
	w.get(`a[href="/dashboard/postbox/inbox?mailbox=${mailboxId}"]`);

describe('an inbox in the sidebar as a drop target', () => {
	it('moves the dragged rows into the inbox it is dropped on, and spends the selection', async () => {
		const spent = vi.fn();
		const w = mountNav(true);
		startDrag(['m1', 'm2'], { spent });
		const team = railEntry(w, 'mb_team');

		expect(fire(team.element, 'dragover')).toBe(true);
		await nextTick();
		expect(team.classes()).toContain('pbx-drop-target');

		expect(fire(team.element, 'drop')).toBe(true);
		await vi.waitFor(() => expect(transfer).toHaveBeenCalled());
		expect(confirmTarget).toHaveBeenCalledWith('mb_team');
		expect(transfer).toHaveBeenCalledWith(['m1', 'm2'], 'mb_team', 'move');
		expect(transferSources).toEqual(['mb_dev']);
		await vi.waitFor(() => expect(spent).toHaveBeenCalled());
		await nextTick();
		expect(team.classes()).not.toContain('pbx-drop-target');
	});

	it('copies with Shift held, and leaves the selection alone', async () => {
		const spent = vi.fn();
		const w = mountNav(true);
		startDrag(['m1'], { spent });

		fire(railEntry(w, 'mb_team').element, 'drop', true);

		await vi.waitFor(() => expect(transfer).toHaveBeenCalledWith(['m1'], 'mb_team', 'copy'));
		expect(spent).not.toHaveBeenCalled();
	});

	it('does nothing when the team inbox confirmation is declined', async () => {
		confirmTarget.mockResolvedValueOnce(false);
		const w = mountNav(true);
		startDrag(['m1']);

		fire(railEntry(w, 'mb_team').element, 'drop');

		await vi.waitFor(() => expect(confirmTarget).toHaveBeenCalled());
		await nextTick();
		expect(transfer).not.toHaveBeenCalled();
	});

	it('refuses the inbox the rows came from, a pin-only drag, and no drag at all', () => {
		const w = mountNav(true);
		expect(fire(railEntry(w, 'mb_team').element, 'dragover')).toBe(false);

		startDrag(['m1'], { mailboxId: 'mb_team' });
		expect(fire(railEntry(w, 'mb_team').element, 'dragover')).toBe(false);
		usePostboxMessageDrag().end();

		startDrag(['m1'], { pinOnly: true });
		expect(fire(railEntry(w, 'mb_team').element, 'dragover')).toBe(false);
	});

	it('takes the drop on the header of an unfolded inbox group too', async () => {
		const w = mountNav(false);
		startDrag(['m1']);
		const header = railEntry(w, 'mb_team').element.closest('.group\\/inbox')!;

		expect(fire(header, 'dragover')).toBe(true);
		await nextTick();
		expect(header.classList).toContain('pbx-drop-target');
		fire(header, 'drop');

		await vi.waitFor(() => expect(transfer).toHaveBeenCalledWith(['m1'], 'mb_team', 'move'));
	});
});
