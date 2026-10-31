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
import axe from 'axe-core';
import { installNuxtStubs } from '~/__tests__/a11y';
import { createTestI18n } from '~/__tests__/i18n';
import { focusTooltip } from '~/__tests__/tooltip';
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
/** While set, every write waits on it before it answers. */
let pending: Promise<void> | null;

const OPS: Record<string, string> = {
	'Assign thread': 'assign',
	'Update thread status': 'status',
	'Snooze thread': 'snooze',
	'Unsnooze thread': 'unsnooze',
};

type ClaimError = (e: unknown) => boolean;

function useBackendOperationStub(
	_op: unknown,
	opts: { label: string | (() => string); onError?: ClaimError }
) {
	const label = typeof opts.label === 'function' ? opts.label() : opts.label;
	const op = OPS[label] ?? label;
	return {
		isLoading: ref(false),
		run: vi.fn(async (args: Record<string, unknown>, runOpts?: { onError?: ClaimError }) => {
			calls.push({ op, args });
			if (pending) await pending;
			if (op !== 'unsnooze' && failing.has(String(args['threadId']))) {
				// The run's own claim replaces the operation's, as in the real module.
				const onError = runOpts?.onError ?? opts.onError;
				if (onError?.({ category: 'internal' }) !== true) errorToasts += 1;
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

/** Hold every write until the returned release is called. */
function holdWrites(): () => void {
	let release!: () => void;
	pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	return () => {
		pending = null;
		release();
	};
}
/**
 * axe over the rendered listbox, one `rule: markup` line per violating node.
 * The rule families of the shared harness (`~/__tests__/a11y`); colour contrast
 * needs a layout engine happy-dom does not have.
 */
async function listViolations(): Promise<string[]> {
	const results = await axe.run(list().element, {
		resultTypes: ['violations'],
		runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'],
		rules: { 'color-contrast': { enabled: false } },
	});
	return results.violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.html}`));
}
const errorSummaries = () => toasts.filter((t) => t.type === 'error').map((t) => t.message);

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
	pending = null;
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

	it('Enter on a row’s checkbox belongs to the checkbox, not the focused row', async () => {
		await mountPage();
		const navigate = globalThis.navigateTo as unknown as ReturnType<typeof vi.fn>;
		await press('j');
		const checkbox = wrapper
			.get('#inbox-row-b')
			.element.closest('li')!
			.querySelector<HTMLButtonElement>('[data-testid="inbox-row-checkbox"]')!;
		checkbox.focus();
		const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
		checkbox.dispatchEvent(enter);
		// The button's native activation is the click the browser sends next.
		checkbox.click();
		await flushPromises();
		expect(navigate).not.toHaveBeenCalled();
		expect(selectedIds()).toEqual(['b']);
		// Enter on the list itself still opens the focused row.
		await press('Enter');
		expect(navigate).toHaveBeenCalledWith('/dashboard/inbox/a');
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

describe('Team Inbox list: accessibility', () => {
	it('keeps each row’s checkbox outside its option, so no control nests in the option', async () => {
		await mountPage();
		await press('j');
		await press('x');
		for (const id of ['a', 'b', 'c', 'd']) {
			const option = wrapper.get(`#inbox-row-${id}`).element;
			expect(option.querySelector('button, a[href], input, [tabindex]')).toBeNull();
			const checkbox = option.closest('li')!.querySelector('[data-testid="inbox-row-checkbox"]');
			expect(checkbox?.tagName).toBe('BUTTON');
			expect(checkbox?.getAttribute('aria-label')).toBe(id === 'a' ? 'Deselect' : 'Select');
		}
		// The one gap left is the listbox owning the per-row controls (the
		// checkbox and the hover quick actions) beside its options, which the
		// Postbox list shares (postboxA11y.test.ts). Closing it means the grid
		// pattern, a keyboard-model change. Pinned to that rule on the listbox
		// alone, so anything else, a nested control included, fails here.
		const violations = await listViolations();
		expect(violations).toHaveLength(1);
		expect(violations[0]).toMatch(/^aria-required-children: <ul role="listbox"/);
	});

	it('has no axe violations for a viewer without triage controls', async () => {
		await mountPage({ admin: false });
		expect(wrapper.find('[data-testid="inbox-row-checkbox"]').exists()).toBe(false);
		expect(await listViolations()).toEqual([]);
	});

	it('names the next order in the sort chip’s tooltip, which keyboard focus opens', async () => {
		await mountPage();
		const chip = wrapper.findAll('button').find((b) => b.text().startsWith('Sorted by'))!;
		expect(chip.attributes('title')).toBeUndefined();
		expect(chip.text()).toBe('Sorted by needs attention');
		expect(await focusTooltip(chip)).toBe('Sort by oldest waiting');
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
		// Picked through the popover's own event: a click on a button that
		// rendered in the same millisecond is dropped by Vue's handler guard,
		// once the row's capture-phase listener has seen the event.
		const rowPicker = wrapper
			.findAllComponents(AssignPopoverStub)
			.find((popover) => popover.props('open'));
		rowPicker!.vm.$emit('assign', 'user2');
		await flushPromises();
		expect(forward('assign')).toEqual([['a', 'user2']]);
	});

	it('a assigns the rows captured when the picker opened, though one left the list since', async () => {
		await mountPage();
		await press('j');
		await press('x');
		await press('J', { shiftKey: true });
		await press('a');
		// A leaves through a live update while the picker is up; B already
		// belongs to Grace, so the live selection alone would assign nothing.
		threads.value = threads.value.filter((t) => t._id !== 'a');
		await flushPromises();
		await bulkBar().get('[data-testid="assign-grace"]').trigger('click');
		await flushPromises();
		expect(forward('assign')).toEqual([['a', 'user2']]);
	});
});

describe('Team Inbox list: selection made with the mouse', () => {
	const check = async (id: string) => {
		wrapper
			.get(`#inbox-row-${id}`)
			.element.closest('li')!
			.querySelector<HTMLElement>('[data-testid="inbox-row-checkbox"]')!
			.click();
		await flushPromises();
	};

	it('runs a key on the selection with no row focused', async () => {
		await mountPage();
		await check('b');
		await check('d');
		await press('e');
		expect(forward('status')).toEqual([
			['b', 'resolved'],
			['d', 'resolved'],
		]);
	});

	it('keeps the rest of the selection when one selected row is triaged on its own', async () => {
		await mountPage();
		await check('a');
		await check('c');
		const row = wrapper.get('#inbox-row-a').element.closest('li')!;
		row.querySelector<HTMLElement>('[aria-label="Resolve"]')!.click();
		await flushPromises();
		expect(forward('status')).toEqual([['a', 'resolved']]);
		expect(selectedIds()).toEqual(['c']);
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
		// One summary instead of a toast per failed row; only the first failure,
		// though both were in flight together, keeps its specific error.
		const summary = toasts.filter((t) => t.type === 'error');
		expect(summary.map((t) => t.message)).toEqual([
			"2 of 4 conversations weren't resolved. They stay selected.",
		]);
		expect(errorToasts).toBe(1);

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

describe('Team Inbox list: failures in flight', () => {
	it('keeps one specific error when a run’s writes fail together, and counts per run', async () => {
		failing = new Set(['a', 'b', 'c', 'd']);
		await mountPage();
		await press('j');
		await press('x');
		await press('J', { shiftKey: true });
		await press('J', { shiftKey: true });
		await press('J', { shiftKey: true });
		const release = holdWrites();
		await wrapper.get('[data-testid="inbox-bulk-resolve"]').trigger('click');
		await flushPromises();
		// All four are in flight before any of them answers.
		expect(forward('status').map(([id]) => id)).toEqual(['a', 'b', 'c', 'd']);
		release();
		await flushPromises();
		expect(errorToasts).toBe(1);
		expect(errorSummaries()).toHaveLength(1);
		expect(selectedIds()).toEqual(['a', 'b', 'c', 'd']);
		// A retry is a run of its own: its first failure speaks again.
		await press('e');
		expect(errorToasts).toBe(2);
	});

	it('does not select an old failure in the view the person moved to', async () => {
		failing = new Set(['b']);
		await mountPage();
		await press('j');
		await press('x');
		await press('J', { shiftKey: true });
		const release = holdWrites();
		await wrapper.get('[data-testid="inbox-bulk-resolve"]').trigger('click');
		await flushPromises();
		filter.value = 'waiting';
		await flushPromises();
		expect(selectedIds()).toEqual([]);
		release();
		await flushPromises();
		// B is back on screen (its write failed) but not selected, and the run
		// still says what failed, without claiming it stayed selected.
		expect(wrapper.find('#inbox-row-b').exists()).toBe(true);
		expect(selectedIds()).toEqual([]);
		expect(errorSummaries()).toEqual(["1 of 2 conversations wasn't resolved."]);
	});
});

describe('Team Inbox list: snooze undo', () => {
	it('puts a rescheduled row back to its own deadline and wakes one that was not snoozed', async () => {
		const later = Date.now() + 86_400_000;
		filter.value = 'snoozed';
		threads.value = [
			thread('a', { snoozedUntil: later }),
			thread('b', { snoozedUntil: later + 1000 }),
			thread('c'),
		];
		await mountPage();
		await press('j');
		await press('x');
		await press('J', { shiftKey: true });
		await press('J', { shiftKey: true });
		await press('h');
		await wrapper.get('[data-testid="snooze-confirm"]').trigger('click');
		await flushPromises();
		expect(forward('snooze').map(([id]) => id)).toEqual(['a', 'b', 'c']);

		calls = [];
		const notice = toasts.find((t) => t.message.startsWith('Snoozed 3'));
		notice!.action!.onAction();
		await flushPromises();
		expect(forward('snooze').sort()).toEqual([
			['a', later],
			['b', later + 1000],
		]);
		expect(forward('unsnooze')).toEqual([['c', undefined]]);
	});
});

describe('Team Inbox list: undo of a selection larger than the undo stack', () => {
	// The undo stack keeps ten entries; a bulk verb must be one of them, or
	// its own later rows would evict its earlier ones.
	const ids = Array.from({ length: 12 }, (_, i) => `t${String(i + 1).padStart(2, '0')}`);
	async function selectAll() {
		await press('j');
		await press('x');
		for (let i = 1; i < ids.length; i++) await press('J', { shiftKey: true });
		expect(selectedIds()).toHaveLength(ids.length);
	}
	const undoNotice = () => {
		const notices = toasts.filter((t) => t.type === 'success');
		expect(notices).toHaveLength(1);
		return notices[0]!;
	};

	it('e on twelve rows counts all twelve, and its undo restores every one', async () => {
		threads.value = ids.map((id, i) => thread(id, { status: i % 2 ? 'waiting' : 'open' }));
		await mountPage();
		await selectAll();
		await press('e');
		expect(forward('status')).toHaveLength(12);
		expect(usePostboxTriageUndo().depth.value).toBe(1);
		const notice = undoNotice();
		expect(notice.message).toBe('Resolved 12 conversations');

		calls = [];
		notice.action!.onAction();
		await flushPromises();
		expect(forward('status').sort()).toEqual(
			ids.map((id, i) => [id, i % 2 ? 'waiting' : 'open']).sort()
		);
		expect(wrapper.findAll('[role="option"]')).toHaveLength(12);
	});

	it('Cmd/Ctrl+Z undoes the whole twelve-row run at once', async () => {
		threads.value = ids.map((id) => thread(id));
		await mountPage();
		await selectAll();
		await press('e');
		calls = [];
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }));
		await flushPromises();
		expect(forward('status')).toHaveLength(12);
		expect(usePostboxTriageUndo().depth.value).toBe(0);
	});

	it('a on twelve rows gives every one back its own prior owner', async () => {
		threads.value = ids.map((id, i) => thread(id, i < 3 ? { assignedTo: 'user1' } : {}));
		await mountPage();
		await selectAll();
		await press('a');
		await bulkBar().get('[data-testid="assign-grace"]').trigger('click');
		await flushPromises();
		expect(forward('assign')).toHaveLength(12);
		const notice = undoNotice();
		expect(notice.message).toBe('Assigned 12 conversations to Grace Hopper');

		calls = [];
		notice.action!.onAction();
		await flushPromises();
		expect(forward('assign').sort()).toEqual(
			ids.map((id, i) => [id, i < 3 ? 'user1' : undefined]).sort()
		);
	});

	it('h on twelve rows wakes every one of them on undo', async () => {
		threads.value = ids.map((id) => thread(id));
		await mountPage();
		await selectAll();
		await press('h');
		await wrapper.get('[data-testid="snooze-confirm"]').trigger('click');
		await flushPromises();
		expect(forward('snooze')).toHaveLength(12);
		const notice = undoNotice();
		expect(notice.message).toBe('Snoozed 12 conversations');

		calls = [];
		notice.action!.onAction();
		await flushPromises();
		expect(
			forward('unsnooze')
				.map(([id]) => id)
				.sort()
		).toEqual(ids);
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

	it('opens the focused row’s menu from the keyboard menu key', async () => {
		await mountPage();
		await press('j');
		await press('j');
		await press('F10', { shiftKey: true });
		expect(menuLabels()).toContain('ResolveE');
		await pickMenu('Resolve');
		expect(forward('status')).toEqual([['b', 'resolved']]);
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
