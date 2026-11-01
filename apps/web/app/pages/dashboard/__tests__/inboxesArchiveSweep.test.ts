/**
 * All inboxes is where Today's "Filed away" mailbox tiles land
 * (`/dashboard/inboxes?in=…&category=…`). Its mail rows get a hover Archive
 * that archives the CONVERSATION by thread id, and a sweep from it; team-inbox
 * rows have no archive and are never part of one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { installNuxtStubs } from '~/__tests__/a11y';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

const registerMoveBack = vi.fn();
vi.mock('~/composables/postbox/usePostboxTriageUndo', () => ({
	usePostboxTriageUndo: () => ({ registerMoveBack }),
}));

const ROW_PX = 50;
let runs: Array<{ label: string; args: unknown }>;

const mailThread = (id: string, at: number) => ({
	_id: id,
	latestSubject: `Newsletter ${id}`,
	latestFromAddress: 'news@example.com',
	latestSnippet: 'This week',
	lastMessageAt: at,
	unreadCount: 0,
	latestMessageId: `msg_${id}`,
});

function install() {
	installNuxtStubs({
		...i18nStubs,
		useRoute: () => ({ query: {}, params: {}, path: '/dashboard/inboxes' }),
		useInboxes: () => ({
			inboxes: ref([{ mailboxId: 'mbx_a', name: 'Support', slot: 0, unread: 0 }]),
			ids: ref(['mbx_a']),
			byId: ref(new Map([['mbx_a', { mailboxId: 'mbx_a', name: 'Support', slot: 0 }]])),
			isLoading: ref(false),
			error: ref(null),
			refetch: vi.fn(),
		}),
		useConvexQueryMap: () =>
			new Map([
				[
					'mbx_a',
					{
						data: ref({
							threads: [mailThread('t1', 40), mailThread('t2', 30), mailThread('t3', 10)],
						}),
						isLoading: ref(false),
						error: ref(null),
						refetch: vi.fn(),
					},
				],
			]),
		// The team inbox is on for this admin: one team thread sorts between t2 and t3.
		useConvexQuery: () => ({
			data: ref({
				threads: [
					{
						_id: 'team_1',
						subject: 'Team question',
						contactIdentifier: 'c@example.com',
						lastMessageAt: 20,
						unread: false,
					},
				],
			}),
			isLoading: ref(false),
			error: ref(null),
			refetch: vi.fn(),
		}),
		useBackendOperation: (_fn: unknown, opts: { label: () => string }) => ({
			run: vi.fn(async (args: { threads?: { threadId: string }[] }) => {
				runs.push({ label: opts.label(), args });
				const threadIds = (args.threads ?? []).map((thread) => thread.threadId);
				return {
					ok: true,
					result: {
						ok: true,
						moved: threadIds.map((id) => ({ messageId: `msg_${id}`, sourceFolderId: 'inbox' })),
						threads: threadIds.map((threadId) => ({
							threadId,
							moved: 1,
							isDone: true,
							after: null,
							hasLeftInbox: true,
						})),
					},
				};
			}),
		}),
	});
}

async function render() {
	const { default: Page } = await import('../inboxes.vue');
	const wrapper = mount(Page, {
		attachTo: document.body,
		global: {
			plugins: [createTestI18n()],
			stubs: {
				InboxChip: true,
				ShellStatusPill: true,
				UiSkeleton: true,
				InboxReadFailureNotice: true,
				NuxtLink: { template: '<a><slot /></a>' },
			},
			mocks: { formatCompactRelativeTime: () => '1m' },
		},
	});
	// happy-dom lays nothing out: give each row its own 50px band.
	for (const [i, li] of wrapper.findAll('li[data-sweep-row]').entries()) {
		li.element.getBoundingClientRect = () =>
			({ top: i * ROW_PX, bottom: (i + 1) * ROW_PX }) as DOMRect;
	}
	return wrapper;
}

function pointer(type: string, y: number): PointerEvent {
	const event = new Event(type, { bubbles: true, cancelable: true });
	Object.defineProperties(event, {
		clientX: { value: 10 },
		clientY: { value: y },
		pointerType: { value: 'mouse' },
		pointerId: { value: 1 },
		isPrimary: { value: true },
		button: { value: 0 },
		shiftKey: { value: false },
		metaKey: { value: false },
		ctrlKey: { value: false },
		altKey: { value: false },
	});
	return event as PointerEvent;
}

const ARCHIVE = 'Archive conversations';

beforeEach(() => {
	runs = [];
	registerMoveBack.mockClear();
	install();
});

describe('All inboxes: Archive and the sweep from it', () => {
	it('offers Archive on mail rows only, and archives the conversation by thread id', async () => {
		const wrapper = await render();
		const rows = wrapper.findAll('li[data-sweep-row]');
		expect(rows.map((r) => r.find('[data-testid="inboxes-row-archive"]').exists())).toEqual([
			true,
			true,
			false,
			true,
		]);

		await rows[0]!.find('[data-testid="inboxes-row-archive"]').trigger('click');

		expect(runs).toEqual([{ label: ARCHIVE, args: { threads: [{ threadId: 't1' }] } }]);
		await nextTick();
		expect(wrapper.text()).not.toContain('Newsletter t1');
		wrapper.unmount();
	});

	it('a sweep from Archive archives the range in one call on release, skipping the team row', async () => {
		const wrapper = await render();
		const handle = wrapper.findAll('[data-testid="inboxes-row-archive"]')[0]!;

		handle.element.dispatchEvent(pointer('pointerdown', 25));
		window.dispatchEvent(pointer('pointermove', 33));
		window.dispatchEvent(pointer('pointermove', 175));
		await nextTick();
		expect(runs).toEqual([]);
		expect(wrapper.find('[role="status"]').text()).toContain('Archive 3 conversations');

		window.dispatchEvent(pointer('pointerup', 175));
		// The click the release leaves on the handle is swallowed: no second archive.
		handle.element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
		await nextTick();

		expect(runs).toEqual([
			{
				label: ARCHIVE,
				args: { threads: [{ threadId: 't1' }, { threadId: 't2' }, { threadId: 't3' }] },
			},
		]);
		expect(wrapper.text()).toContain('Team question');
		wrapper.unmount();
	});
});
