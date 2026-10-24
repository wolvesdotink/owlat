/**
 * Team Inbox list triage at Postbox level, rendered: the real page, the real
 * rows, the real selection, keyboard, bulk bar and row menu, against a stubbed
 * list read and recorded mutations.
 *
 *   - `x` selects the focused row, Shift+J/K extend from the anchor, Esc clears
 *   - `e` resolves, `h` snoozes, `a` assigns, `i` still assigns to me — each on
 *     the selection when there is one, else on the focused row
 *   - the bulk bar counts the selection and runs the same verbs
 *   - a partial failure says so once, keeps exactly the failed rows selected,
 *     and undo restores only the rows that changed, each to its own prior state
 *   - the row menu acts on the selection when the row is part of it, counts
 *     those rows in its labels, and shows the list's keys
 *   - the selection follows the list: a row that leaves drops out of it, and a
 *     change of view clears it
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, nextTick, ref, type Ref } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { installNuxtStubs } from '~/__tests__/a11y';
import { createTestI18n } from '~/__tests__/i18n';
import { usePostboxListKeyboard } from '~/composables/postbox/usePostboxListKeyboard';
import { usePostboxOptimisticHide } from '~/composables/postbox/usePostboxOptimisticHide';
import { usePostboxTriageUndo } from '~/composables/postbox/usePostboxTriageUndo';
import { useInboxTriage } from '~/composables/useInboxTriage';
import InboxThreadRow, { type InboxThreadRowThread } from '~/components/inbox/InboxThreadRow.vue';
import InboxBulkBar from '~/components/inbox/InboxBulkBar.vue';
import PostboxRowCore from '~/components/postbox/PostboxRowCore.vue';
import StatusChip from '~/components/inbox/StatusChip.vue';
import UiQueryBoundary from '~/components/ui/QueryBoundary.vue';
import InboxIndex from '../index.vue';

vi.mock('~/composables/useOrganization', () => ({
	useOrganization: () => ({
		organization: ref({ id: 'org1', name: 'Owlat' }),
		members: ref([
			{ userId: 'user2', user: { name: 'Grace Hopper', email: 'grace@example.com', image: null } },
		]),
		fetchMembers: vi.fn(),
		isLoading: ref(false),
	}),
}));

type Thread = InboxThreadRowThread;

function thread(id: string, extra: Partial<Thread> = {}): Thread {
	return {
		_id: id,
		_creationTime: 1,
		subject: `Subject ${id}`,
		contactIdentifier: `${id}@example.com`,
		status: 'open',
		lastMessageAt: 10,
		...extra,
	};
}

// --- Recorded mutations ---------------------------------------------------

interface Call {
	op: string;
	args: Record<string, unknown>;
}
let calls: Call[];
/** Thread ids whose forward write fails. */
let failing: Set<string>;
/** Error toasts the default failure treatment would have raised. */
let errorToasts: number;

const OPS: Record<string, string> = {
	'Assign thread': 'assign',
	'Update thread status': 'status',
	'Snooze thread': 'snooze',
	'Unsnooze thread': 'unsnooze',
};

function useBackendOperationStub(
	_op: unknown,
	opts: { label: string | (() => string); onError?: (e: unknown) => boolean }
) {
	const label = typeof opts.label === 'function' ? opts.label() : opts.label;
	const op = OPS[label] ?? label;
	return {
		isLoading: ref(false),
		run: vi.fn(async (args: Record<string, unknown>) => {
			calls.push({ op, args });
			if (op !== 'unsnooze' && failing.has(String(args['threadId']))) {
				if (opts.onError?.({ category: 'internal' }) !== true) errorToasts += 1;
				return { ok: false };
			}
			return { ok: true, result: { success: true } };
		}),
	};
}

// --- Toasts (the undo notices and the bulk summary) -------------------------

interface Toast {
	id: string;
	message: string;
	type: string;
	action?: { label: string; onAction: () => void };
}
let toasts: Toast[];
let toastSeq = 0;
const toastStub = () => ({
	toasts: ref([]),
	showToast: (message: string, type = 'success', options?: { action?: Toast['action'] }) => {
		const id = `toast-${++toastSeq}`;
		toasts.push({ id, message, type, ...(options?.action ? { action: options.action } : {}) });
		return id;
	},
	removeToast: (id: string) => {
		toasts = toasts.filter((t) => t.id !== id);
	},
	updateToast: (id: string, patch: { message?: string; action?: Toast['action'] }) => {
		const toast = toasts.find((t) => t.id === id);
		if (!toast) return;
		if (patch.message !== undefined) toast.message = patch.message;
		if (patch.action) toast.action = patch.action;
	},
	setToastShortcutHint: vi.fn(),
	clearToasts: vi.fn(),
});

// --- The list read ---------------------------------------------------------

let threads: Ref<Thread[]>;
let filter: Ref<string>;
let stateBuckets: Map<string, Ref<unknown>>;

const AssignPopoverStub = defineComponent({
	props: ['members', 'currentUserId', 'assignedTo', 'open', 'position', 'assignShortcutId'],
	emits: ['assign', 'update:open'],
	template: `<span>
		<slot name="trigger" />
		<span v-if="open" data-testid="assign-picker">
			<button data-testid="assign-grace" @click="$emit('assign', 'user2'); $emit('update:open', false)" />
		</span>
	</span>`,
});
const SnoozeDialogStub = defineComponent({
	props: ['open'],
	emits: ['update:open', 'confirm'],
	template: `<div v-if="open" data-testid="snooze-dialog">
		<button data-testid="snooze-confirm" @click="$emit('confirm', 99999)" />
	</div>`,
});
const ButtonStub = defineComponent({
	emits: ['click'],
	template: `<button type="button" @click="$emit('click', $event)"><slot name="iconLeft" /><slot /></button>`,
});

let wrapper: VueWrapper;
const i18n = createTestI18n();

async function mountPage(opts: { admin?: boolean } = {}) {
	const admin = opts.admin ?? true;
	installNuxtStubs({
		// The global composer, so the undo module (called outside a component
		// in teardown too) reads the same catalog.
		useI18n: () => i18n.global,
		formatCompactRelativeTime: () => '5m',
		useState: (key: string, init?: () => unknown) => {
			if (!stateBuckets.has(key)) stateBuckets.set(key, ref(init?.()));
			return stateBuckets.get(key);
		},
		usePermissions: () => ({
			isAdmin: ref(admin),
			showAdminGate: ref(false),
			role: ref(admin ? 'owner' : 'editor'),
		}),
		useInbox: () => ({
			now: ref(100),
			filter,
			assignee: ref('anyone'),
			mentions: ref(false),
			unreadMentions: ref(0),
			sort: ref('needs-attention'),
			setSort: vi.fn(),
			toggleSort: vi.fn(),
			filterCounts: ref(null),
			slaSummary: ref(null),
			isSlaEnabled: ref(false),
			threads,
			threadsLoading: ref(false),
			threadsError: ref(null),
			retryThreads: vi.fn(),
			hasMoreThreads: ref(false),
			stats: ref(null),
			loadMoreThreads: vi.fn(),
		}),
		useInboxTriage,
		usePostboxOptimisticHide,
		usePostboxListKeyboard,
		useInboxAssigneePresence: () => () => false,
		useInboxNoteCounts: () => () => 0,
		useBackendOperation: useBackendOperationStub,
		useToast: toastStub,
	});
	wrapper = mount(InboxIndex, {
		attachTo: document.body,
		global: {
			plugins: [i18n],
			// A template auto-import; the test build does not rewrite templates.
			mocks: { formatCompactRelativeTime: () => '5m' },
			components: {
				InboxThreadRow,
				InboxBulkBar,
				PostboxRowCore,
				InboxStatusChip: StatusChip,
				UiQueryBoundary,
			},
			stubs: {
				Icon: true,
				UiAvatar: true,
				UiPresenceRing: { template: '<span><slot /></span>' },
				UiPageHeader: true,
				UiButton: ButtonStub,
				UiEmptyState: true,
				UiIconBox: true,
				InboxFilterPills: true,
				InboxAssignPopover: AssignPopoverStub,
				PostboxSnoozeDialog: SnoozeDialogStub,
				PostboxThreadListSkeleton: true,
				PostboxSwipeTrack: true,
				NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
			},
		},
	});
	await flushPromises();
}

const list = () => wrapper.get('ul[role="listbox"]');
async function press(key: string, init: KeyboardEventInit = {}) {
	await list().trigger('keydown', { key, ...init });
	await flushPromises();
}
const selectedIds = () =>
	wrapper
		.findAll('[role="option"]')
		.filter((o) => o.attributes('aria-selected') === 'true')
		.map((o) => o.attributes('id')!.replace('inbox-row-', ''));
const bulkBar = () => wrapper.find('[data-testid="inbox-bulk-bar"]');
const forward = (op: string) =>
	calls
		.filter((c) => c.op === op)
		.map((c) => [c.args['threadId'], c.args['status'] ?? c.args['assignedTo'] ?? c.args['until']]);

const menu = () => document.body.querySelector<HTMLElement>('[role="menu"]');
const menuLabels = () =>
	Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')).map((el) =>
		el.textContent!.replace(/\s+/g, ' ').trim()
	);
async function rightClick(id: string) {
	await wrapper
		.get(`#inbox-row-${id}`)
		.element.closest('li')!
		.dispatchEvent(
			new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })
		);
	await flushPromises();
}
async function pickMenu(label: string) {
	const item = Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
		(el) => el.textContent!.replace(/\s+/g, ' ').trim().startsWith(label)
	);
	expect(item, `menu item ${label}`).toBeTruthy();
	item!.click();
	await flushPromises();
}

beforeEach(() => {
	calls = [];
	failing = new Set();
	errorToasts = 0;
	toasts = [];
	stateBuckets = new Map();
	filter = ref('open');
	threads = ref([
		thread('a'),
		thread('b', { status: 'waiting', assignedTo: 'user2' }),
		thread('c'),
		thread('d'),
	]);
});

afterEach(() => {
	usePostboxTriageUndo().dismiss();
	wrapper?.unmount();
	document.body.innerHTML = '';
});

describe('Team Inbox list: selection', () => {
	it('x selects the focused row and the bulk bar counts it; focus is not selection', async () => {
		await mountPage();
		expect(list().attributes('aria-multiselectable')).toBe('true');
		await press('j');
		expect(selectedIds()).toEqual([]);
		expect(bulkBar().exists()).toBe(false);
		await press('x');
		expect(selectedIds()).toEqual(['a']);
		expect(bulkBar().text()).toContain('1 selected');
		await press('x');
		expect(selectedIds()).toEqual([]);
	});

	it('Shift+J extends from the anchor and Esc clears', async () => {
		await mountPage();
		await press('j');
		await press('x');
		await press('J', { shiftKey: true });
		await press('J', { shiftKey: true });
		expect(selectedIds()).toEqual(['a', 'b', 'c']);
		await press('K', { shiftKey: true });
		expect(selectedIds()).toEqual(['a', 'b', 'c']);
		await press('Escape');
		expect(selectedIds()).toEqual([]);
	});

	it('Shift+click on a row extends the range instead of opening it', async () => {
		await mountPage();
		await wrapper.get('#inbox-row-a').element.closest('li')!.querySelector('button')!.click();
		await flushPromises();
		const row = wrapper.get('#inbox-row-c');
		row.element.dispatchEvent(
			new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true })
		);
		await flushPromises();
		expect(selectedIds()).toEqual(['a', 'b', 'c']);
	});

	it('drops a row that leaves the list and clears on a change of view', async () => {
		await mountPage();
		await press('j');
		await press('x');
		await press('J', { shiftKey: true });
		expect(selectedIds()).toEqual(['a', 'b']);
		threads.value = threads.value.filter((t) => t._id !== 'a');
		await flushPromises();
		expect(selectedIds()).toEqual(['b']);
		expect(bulkBar().text()).toContain('1 selected');
		filter.value = 'waiting';
		await flushPromises();
		expect(selectedIds()).toEqual([]);
	});
});

describe('Team Inbox list: triage keys', () => {
	it('e resolves the focused row when nothing is selected', async () => {
		await mountPage();
		await press('j');
		await press('j');
		await press('e');
		expect(forward('status')).toEqual([['b', 'resolved']]);
	});

	it('e resolves the whole selection, skipping a row already resolved', async () => {
		threads.value = [thread('a'), thread('b', { status: 'resolved' }), thread('c'), thread('d')];
		await mountPage();
		await press('j');
		await press('x');
		await press('J', { shiftKey: true });
		await press('J', { shiftKey: true });
		await press('e');
		expect(forward('status')).toEqual([
			['a', 'resolved'],
			['c', 'resolved'],
		]);
		// One notice counts the run.
		expect(toasts.map((t) => t.message)).toEqual(['Resolved 2 conversations']);
		// Resolved rows leave the Open tab, and the selection goes with them.
		expect(selectedIds()).toEqual([]);
	});

	it('i still assigns the focused row to me', async () => {
		await mountPage();
		await press('j');
		await press('i');
		expect(forward('assign')).toEqual([['a', 'user1']]);
	});

	it('h snoozes the selection captured when the picker opened', async () => {
		await mountPage();
		await press('j');
		await press('x');
		await press('J', { shiftKey: true });
		await press('h');
		expect(wrapper.find('[data-testid="snooze-dialog"]').exists()).toBe(true);
		// The selection changes while the picker is up; the snooze does not.
		await press('J', { shiftKey: true });
		await wrapper.get('[data-testid="snooze-confirm"]').trigger('click');
		await flushPromises();
		expect(forward('snooze')).toEqual([
			['a', 99999],
			['b', 99999],
		]);
	});

	it('a opens the bulk assignee picker for a selection and assigns every row', async () => {
		await mountPage();
		await press('j');
		await press('x');
		await press('J', { shiftKey: true });
		await press('J', { shiftKey: true });
		await press('a');
		const picker = bulkBar().find('[data-testid="assign-picker"]');
		expect(picker.exists()).toBe(true);
		await picker.get('[data-testid="assign-grace"]').trigger('click');
		await flushPromises();
		// Row b already belongs to Grace: nothing to do there.
		expect(forward('assign')).toEqual([
			['a', 'user2'],
			['c', 'user2'],
		]);
	});

	it('a opens the focused row’s own picker when nothing is selected', async () => {
		await mountPage();
		await press('j');
		await press('a');
		const row = wrapper.get('#inbox-row-a').element.closest('li')!;
		expect(row.querySelector('[data-testid="assign-picker"]')).not.toBeNull();
		expect(bulkBar().exists()).toBe(false);
	});
});

describe('Team Inbox list: partial failure and undo', () => {
	it('says so once, keeps the failures selected, and undoes only what changed', async () => {
		threads.value = [
			thread('a', { status: 'waiting' }),
			thread('b'),
			thread('c'),
			thread('d', { status: 'waiting' }),
		];
		failing = new Set(['b', 'c']);
		await mountPage();
		await press('j');
		await press('x');
		await press('J', { shiftKey: true });
		await press('J', { shiftKey: true });
		await press('J', { shiftKey: true });
		await wrapper.get('[data-testid="inbox-bulk-resolve"]').trigger('click');
		await flushPromises();

		expect(forward('status').map(([id]) => id)).toEqual(['a', 'b', 'c', 'd']);
		// The failed rows are back on screen and still selected, to retry.
		expect(selectedIds()).toEqual(['b', 'c']);
		// One summary instead of a toast per failed row (at most the first, and
		// any already in flight with it, keep their specific error).
		const summary = toasts.filter((t) => t.type === 'error');
		expect(summary.map((t) => t.message)).toEqual([
			"2 of 4 conversations weren't resolved. They stay selected.",
		]);
		expect(errorToasts).toBeLessThanOrEqual(2);
		expect(errorToasts).toBeGreaterThanOrEqual(1);

		// Undo all: each succeeded row goes back to its own prior status.
		calls = [];
		const notice = toasts.find((t) => t.message === 'Resolved 2 conversations');
		notice!.action!.onAction();
		await flushPromises();
		expect(forward('status').sort()).toEqual([
			['a', 'waiting'],
			['d', 'waiting'],
		]);
	});
});

describe('Team Inbox list: row menu', () => {
	it('acts on the selection when the row is part of it, and counts it', async () => {
		await mountPage();
		await press('j');
		await press('x');
		await press('J', { shiftKey: true });
		await rightClick('b');
		expect(menu()).not.toBeNull();
		const labels = menuLabels();
		expect(labels).toContain('Resolve (2)E');
		expect(labels).toContain('Snooze… (2)H');
		expect(labels).toContain('Assign to me (2)I');
		expect(labels).toContain('DeselectX');
		await pickMenu('Resolve (2)');
		expect(forward('status')).toEqual([
			['a', 'resolved'],
			['b', 'resolved'],
		]);
	});

	it('acts on the row alone when it is not selected', async () => {
		await mountPage();
		await press('j');
		await press('x');
		await rightClick('c');
		expect(menuLabels()).toContain('ResolveE');
		await pickMenu('Resolve');
		expect(forward('status')).toEqual([['c', 'resolved']]);
		// The selection made elsewhere is untouched.
		expect(selectedIds()).toEqual(['a']);
	});

	it('offers a non-admin only the row’s link verbs', async () => {
		await mountPage({ admin: false });
		expect(list().attributes('aria-multiselectable')).toBeUndefined();
		await rightClick('a');
		expect(menuLabels().map((l) => l.replace(/Enter$/, ''))).toEqual([
			'Open',
			'Open in new tab',
			'Copy link',
		]);
	});
});
