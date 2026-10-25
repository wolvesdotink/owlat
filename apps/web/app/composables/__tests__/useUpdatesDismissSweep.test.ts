/**
 * useUpdatesDismissSweep — press Dismiss on a Team Updates row and drag to
 * dismiss the range (where Today's "Filed away" Team Inbox tiles land).
 *
 * Dismissal is admin-only and terminal, so what is pinned is that a sweep
 * obeys the button's guards (admin, not Spam, nothing else running), touches
 * only rows still waiting as updates, does nothing before release, restores
 * each failed row, and reports one toast and at most one error for the batch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { effectScope, nextTick, ref, type EffectScope } from 'vue';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

const ROW_PX = 50;

type Row = { _id: string; item: { message: { processingStatus?: string } } };

let runs: string[];
let failing: Set<string>;
let surfaced: number;
let toasts: string[];
let scope: EffectScope;
let list: HTMLElement;

beforeEach(() => {
	runs = [];
	failing = new Set();
	surfaced = 0;
	toasts = [];
	vi.useFakeTimers();
	vi.stubGlobal('useI18n', () => ({
		t: (key: string, params?: { count?: number }) =>
			params?.count === undefined ? key : `${key}:${params.count}`,
	}));
	vi.stubGlobal('useToast', () => ({ showToast: (message: string) => toasts.push(message) }));
	// Mirrors useBackendOperation's contract: a failure goes to `onError`, and
	// only an unclaimed one reaches the default error surface.
	vi.stubGlobal(
		'useBackendOperation',
		(_fn: unknown, opts: { onError?: (error: unknown) => boolean }) => ({
			run: vi.fn(async (args: { inboundMessageId: string }) => {
				runs.push(args.inboundMessageId);
				if (!failing.has(args.inboundMessageId)) return { ok: true, result: { success: true } };
				if (!opts.onError?.(new Error('invalid_state'))) surfaced += 1;
				return { ok: false };
			}),
		})
	);
});

afterEach(() => {
	scope?.stop();
	list?.remove();
	vi.useRealTimers();
});

const update = (id: string, processingStatus = 'informational'): Row => ({
	_id: id,
	item: { message: { processingStatus } },
});

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

const yOf = (i: number) => i * ROW_PX + ROW_PX / 2;

async function settle() {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

async function mount(initial: Row[], opts: { canDismiss?: boolean } = {}) {
	const { useUpdatesDismissSweep } = await import('../useUpdatesDismissSweep');
	const rows = ref(initial);
	const hidden = ref(new Set<string>());
	const view = ref('updates');
	const actionInProgress = ref<string | null>(null);
	const canDismiss = ref(opts.canDismiss ?? true);
	scope = effectScope();
	const sweep = scope.run(() =>
		useUpdatesDismissSweep({
			rows: rows as never,
			scopeKey: () => view.value,
			canDismiss: () => canDismiss.value,
			actionInProgress,
			rowHide: {
				hide: (id) => (hidden.value = new Set(hidden.value).add(id)),
				unhide: (id) => {
					const next = new Set(hidden.value);
					next.delete(id);
					hidden.value = next;
				},
			},
		})
	)!;
	list = document.createElement('ul');
	for (const [i, row] of initial.entries()) {
		const li = document.createElement('li');
		li.dataset['sweepRow'] = row._id;
		li.getBoundingClientRect = () => ({ top: i * ROW_PX, bottom: (i + 1) * ROW_PX }) as DOMRect;
		list.appendChild(li);
	}
	document.body.appendChild(list);
	sweep.listEl.value = list;
	return { rows, hidden, view, actionInProgress, ...sweep };
}

function drag(api: Awaited<ReturnType<typeof mount>>, from: number, to: number) {
	api.start(api.rows.value[from]!._id as never, pointer('pointerdown', yOf(from)));
	const step = to >= from ? 1 : -1;
	window.dispatchEvent(pointer('pointermove', yOf(from) + step * 8));
	for (let i = from; i !== to + step; i += step)
		window.dispatchEvent(pointer('pointermove', yOf(i)));
}

const release = (row: number) => window.dispatchEvent(pointer('pointerup', yOf(row)));

describe('useUpdatesDismissSweep', () => {
	it('dismisses each update in the range once, on release, with one toast', async () => {
		const api = await mount([update('a'), update('b'), update('c'), update('d')]);

		drag(api, 0, 2);
		expect(runs).toEqual([]);
		expect(api.status.value).toEqual({ mark: 'dismiss', count: 3 });
		expect(api.markOf('b')).toBe('dismiss');

		release(2);
		await settle();

		expect(runs).toEqual(['a', 'b', 'c']);
		expect([...api.hidden.value]).toEqual(['a', 'b', 'c']);
		expect(toasts).toEqual(['dashboard.inbox.updates.dismissedManyToast:3']);
		expect(api.actionInProgress.value).toBeNull();
	});

	it('restores each failed row and surfaces one error for the batch', async () => {
		const api = await mount([update('a'), update('b'), update('c')]);
		failing = new Set(['a', 'c']);

		drag(api, 0, 2);
		release(2);
		await settle();

		expect([...api.hidden.value]).toEqual(['b']);
		expect(surfaced).toBe(1);
		expect(toasts).toEqual(['dashboard.inbox.updates.dismissedManyToast:1']);
	});

	it('skips rows that are no longer waiting as updates', async () => {
		const api = await mount([update('a'), update('b', 'archived'), update('c')]);
		drag(api, 0, 2);
		release(2);
		await settle();
		expect(runs).toEqual(['a', 'c']);
	});

	it('does not start where the Dismiss button would refuse (not admin, or the Spam view)', async () => {
		const api = await mount([update('a'), update('b')], { canDismiss: false });
		drag(api, 0, 1);
		expect(api.status.value).toBeNull();
		release(1);
		await settle();
		expect(runs).toEqual([]);
	});

	it('does not start while another action on the page is running', async () => {
		const api = await mount([update('a'), update('b')]);
		api.actionInProgress.value = 'a';
		drag(api, 0, 1);
		release(1);
		await settle();
		expect(runs).toEqual([]);
	});

	it('switching tabs mid-sweep cancels it', async () => {
		const api = await mount([update('a'), update('b'), update('c')]);
		drag(api, 0, 2);
		api.view.value = 'promotions';
		await nextTick();
		release(2);
		await settle();
		expect(runs).toEqual([]);
	});
});
