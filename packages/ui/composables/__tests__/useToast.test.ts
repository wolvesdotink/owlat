import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useToast } from '../useToast';

beforeEach(() => {
	vi.useFakeTimers();
	useToast().clearToasts();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('useToast', () => {
	it('shows a success toast by default', () => {
		const { showToast, toasts } = useToast();
		showToast('Saved');
		expect(toasts.value).toHaveLength(1);
		expect(toasts.value[0]).toMatchObject({ message: 'Saved', type: 'success' });
	});

	it('shows an error toast when requested', () => {
		const { showToast, toasts } = useToast();
		showToast('Failed', 'error');
		expect(toasts.value[0]?.type).toBe('error');
	});

	it('shares state across composable instances (global toaster)', () => {
		useToast().showToast('From A');
		expect(useToast().toasts.value).toHaveLength(1);
	});

	it('auto-dismisses after 3 seconds', () => {
		const { showToast, toasts } = useToast();
		showToast('Ephemeral');
		expect(toasts.value).toHaveLength(1);
		vi.advanceTimersByTime(3001);
		expect(toasts.value).toHaveLength(0);
	});

	it('keeps error toasts on screen longer than success toasts', () => {
		const { showToast, toasts } = useToast();
		showToast('Saved', 'success');
		showToast('Failed', 'error');
		expect(toasts.value).toHaveLength(2);

		// Just past the success lifetime: the success is gone, the error remains.
		vi.advanceTimersByTime(3001);
		expect(toasts.value).toHaveLength(1);
		expect(toasts.value[0]?.type).toBe('error');

		// The error survives well beyond the success window before it clears.
		vi.advanceTimersByTime(5000);
		expect(toasts.value).toHaveLength(0);
	});

	it('treats a non-positive duration as sticky (never auto-dismisses)', () => {
		const { showToast, toasts } = useToast();
		showToast('Stay put', 'error', { durationMs: 0 });
		vi.advanceTimersByTime(60_000);
		expect(toasts.value).toHaveLength(1);
	});

	it('supports info and warning toast types', () => {
		const { showToast, toasts } = useToast();
		showToast('Heads up', 'info');
		showToast('Careful', 'warning');
		expect(toasts.value.map((t) => t.type)).toEqual(['info', 'warning']);
	});

	it('removes a specific toast without touching the others', () => {
		const { showToast, removeToast, toasts } = useToast();
		showToast('one');
		showToast('two');
		const first = toasts.value[0]!.id;
		removeToast(first);
		expect(toasts.value).toHaveLength(1);
		expect(toasts.value[0]?.message).toBe('two');
	});

	it('clearToasts empties the stack', () => {
		const { showToast, clearToasts, toasts } = useToast();
		showToast('one');
		showToast('two');
		clearToasts();
		expect(toasts.value).toHaveLength(0);
	});

	it('tolerates removing an already-dismissed toast', () => {
		const { showToast, removeToast, toasts } = useToast();
		showToast('one');
		const id = toasts.value[0]!.id;
		removeToast(id);
		expect(() => removeToast(id)).not.toThrow();
	});
});

/**
 * `onDismiss` exists for callers whose follow-up write means "the user has seen
 * this" — a once-ever nudge marking itself acknowledged. Firing it on display
 * would burn the notice on someone who never looked at the screen, and firing
 * it twice would double-write, so both are pinned here.
 */
describe('useToast — onDismiss', () => {
	it('fires when the toast auto-dismisses', () => {
		const { showToast } = useToast();
		const onDismiss = vi.fn();
		showToast('Ephemeral', 'success', { onDismiss });

		expect(onDismiss).not.toHaveBeenCalled();
		vi.advanceTimersByTime(3001);
		expect(onDismiss).toHaveBeenCalledTimes(1);
	});

	it('fires when the toast is dismissed manually', () => {
		const { showToast, removeToast, toasts } = useToast();
		const onDismiss = vi.fn();
		showToast('Sticky', 'success', { durationMs: 0, onDismiss });

		vi.advanceTimersByTime(60_000);
		expect(onDismiss).not.toHaveBeenCalled();

		removeToast(toasts.value[0]!.id);
		expect(onDismiss).toHaveBeenCalledTimes(1);
	});

	it('fires exactly once, however many times the toast is removed', () => {
		const { showToast, removeToast, toasts } = useToast();
		const onDismiss = vi.fn();
		showToast('Once', 'success', { durationMs: 0, onDismiss });

		const id = toasts.value[0]!.id;
		removeToast(id);
		removeToast(id);
		expect(onDismiss).toHaveBeenCalledTimes(1);
	});

	it('fires for every toast cleared by clearToasts', () => {
		const { showToast, clearToasts } = useToast();
		const first = vi.fn();
		const second = vi.fn();
		showToast('one', 'success', { durationMs: 0, onDismiss: first });
		showToast('two', 'success', { durationMs: 0, onDismiss: second });

		clearToasts();
		expect(first).toHaveBeenCalledTimes(1);
		expect(second).toHaveBeenCalledTimes(1);
	});

	it('leaves toasts without a callback alone', () => {
		const { showToast, removeToast, toasts } = useToast();
		showToast('plain');
		expect(() => removeToast(toasts.value[0]!.id)).not.toThrow();
	});
});

/**
 * Observed actions (opt-in): the toast waits for the work behind its button
 * instead of vanishing on press. Pending shows and ignores a second press; a
 * success dismisses; `false` (a failure, or a terminal "expired"/"already")
 * keeps the toast, marked, with nothing to press again; only an explicit
 * `{ retryable: true }` brings the action back. Plain `action` callers are
 * untouched, whatever their callback returns.
 */
describe('useToast — observed actions', () => {
	/*
	 * The action window runs on a stubbed monotonic clock: `elapse` moves it
	 * together with the fake timers, `mono += ms` moves it alone (time passing
	 * while no timer gets to run, as in a throttled tab), and `vi.setSystemTime`
	 * moves only the wall clock.
	 */
	let mono = 0;
	beforeEach(() => {
		mono = 1_000;
		vi.spyOn(performance, 'now').mockImplementation(() => mono);
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});
	function elapse(ms: number) {
		mono += ms;
		vi.advanceTimersByTime(ms);
	}

	function deferred<T>() {
		let resolve!: (value: T) => void;
		let reject!: (error: unknown) => void;
		const promise = new Promise<T>((res, rej) => {
			resolve = res;
			reject = rej;
		});
		return { promise, resolve, reject };
	}

	function observedToast(
		run: () => Promise<boolean | { retryable: true }>,
		options: {
			type?: 'success' | 'info' | 'error';
			durationMs?: number;
			onDismiss?: () => void;
		} = {}
	) {
		const { showToast, toasts } = useToast();
		const id = showToast('Moved to Later', options.type ?? 'success', {
			durationMs: options.durationMs ?? 8000,
			observedAction: { label: 'Undo', pendingLabel: 'Undoing…', failedNote: 'Not undone.', run },
			...(options.onDismiss ? { onDismiss: options.onDismiss } : {}),
		});
		const current = () => toasts.value.find((t) => t.id === id);
		/** What the card does on a press: run the action, then ask to be dismissed. */
		const press = () => {
			const result = current()!.action!.onAction() as unknown as Promise<void>;
			useToast().dismissAfterAction(id);
			return result;
		};
		return { id, current, press };
	}

	it('dismisses a plain action at once, even when its callback returns a promise', async () => {
		const { showToast, dismissAfterAction, toasts } = useToast();
		const never = vi.fn(() => new Promise<boolean>(() => {}));
		const id = showToast('Archived', 'success', {
			action: { label: 'Undo', onAction: never },
		});
		toasts.value[0]!.action!.onAction();
		dismissAfterAction(id);
		expect(never).toHaveBeenCalledTimes(1);
		expect(toasts.value).toHaveLength(0);
	});

	it('keeps a plain action toast to its deadline when not pressed', () => {
		const { showToast, toasts } = useToast();
		showToast('Archived', 'success', {
			durationMs: 8000,
			action: { label: 'Undo', onAction: () => {} },
		});
		elapse(7999);
		expect(toasts.value).toHaveLength(1);
		elapse(1);
		expect(toasts.value).toHaveLength(0);
	});

	it('shows pending until the work succeeds, then dismisses', async () => {
		const work = deferred<boolean>();
		const onDismiss = vi.fn();
		const { current, press } = observedToast(() => work.promise, { onDismiss });
		expect(current()).toMatchObject({ action: { label: 'Undo' } });
		expect(current()?.pending).toBeUndefined();

		const running = press();
		expect(current()).toMatchObject({ pending: true, action: { label: 'Undoing…' } });
		expect(onDismiss).not.toHaveBeenCalled();

		work.resolve(true);
		await running;
		expect(current()).toBeUndefined();
		expect(onDismiss).toHaveBeenCalledTimes(1);
	});

	it('ignores a second press while pending, so the work runs once', async () => {
		const work = deferred<boolean>();
		const run = vi.fn(() => work.promise);
		const { press } = observedToast(run);
		const first = press();
		void press();
		void press();
		expect(run).toHaveBeenCalledTimes(1);
		work.resolve(true);
		await first;
	});

	it('does not dismiss false as success: marked, no action, warning reading time', async () => {
		const run = vi.fn(async () => false);
		const { current, press } = observedToast(run);
		await press();
		expect(current()).toEqual({
			id: current()!.id,
			message: 'Moved to Later. Not undone.',
			type: 'warning',
		});
		// Nothing to press: a bare false is never retried.
		expect(current()?.action).toBeUndefined();
		expect(run).toHaveBeenCalledTimes(1);

		elapse(5999);
		expect(current()).toBeDefined();
		elapse(1);
		expect(current()).toBeUndefined();
	});

	it('treats a rejection as not done, re-throws it, and offers no retry', async () => {
		const run = vi.fn(async (): Promise<boolean> => {
			throw new Error('network down');
		});
		const { current, press } = observedToast(run);
		await expect(press()).rejects.toThrow('network down');
		expect(current()).toMatchObject({ message: 'Moved to Later. Not undone.', type: 'warning' });
		expect(current()?.action).toBeUndefined();
		expect(current()?.pending).toBeUndefined();
	});

	it('does not double the full stop of a message that has one', async () => {
		const { showToast, toasts } = useToast();
		const id = showToast('Moved back.', 'info', {
			observedAction: {
				label: 'Undo',
				pendingLabel: 'Undoing…',
				failedNote: 'Not undone.',
				run: async () => false,
			},
		});
		await (toasts.value[0]!.action!.onAction() as unknown as Promise<void>);
		expect(toasts.value.find((t) => t.id === id)?.message).toBe('Moved back. Not undone.');
	});

	it('keeps an error toast an error when its action fails', async () => {
		const { current, press } = observedToast(async () => false, { type: 'error' });
		await press();
		expect(current()?.type).toBe('error');
	});

	it('keeps a sticky toast sticky after a failure', async () => {
		const { current, press } = observedToast(async () => false, { durationMs: 0 });
		await press();
		elapse(60_000);
		expect(current()?.message).toBe('Moved to Later. Not undone.');
	});

	it('brings the action back only for an explicit retryable outcome', async () => {
		const run = vi
			.fn<() => Promise<boolean | { retryable: true }>>()
			.mockResolvedValueOnce({ retryable: true })
			.mockResolvedValueOnce(true);
		const { current, press } = observedToast(run);
		await press();
		expect(current()).toMatchObject({ pending: false, action: { label: 'Undo' } });
		expect(current()?.message).toBe('Moved to Later');
		await press();
		expect(run).toHaveBeenCalledTimes(2);
		expect(current()).toBeUndefined();
	});

	it('leaves the action deadline alone: a retry is not offered past it', async () => {
		const work = deferred<boolean | { retryable: true }>();
		const { current, press } = observedToast(() => work.promise);
		elapse(7000);
		const running = press();
		// The deadline passes while the work runs: the toast is held for the outcome.
		elapse(2000);
		expect(current()?.pending).toBe(true);
		work.resolve({ retryable: true });
		await running;
		expect(current()).toMatchObject({ message: 'Moved to Later. Not undone.' });
		expect(current()?.action).toBeUndefined();
	});

	it('keeps the card showing the outcome when the action throws before returning a promise', async () => {
		const run = vi.fn((): Promise<boolean> => {
			throw new Error('sync boom');
		});
		const { current, press } = observedToast(run);
		// press() runs the action and then asks to be dismissed, as the card does.
		await expect(press()).rejects.toThrow('sync boom');
		expect(current()).toMatchObject({ message: 'Moved to Later. Not undone.', type: 'warning' });
		expect(current()?.action).toBeUndefined();
	});

	it('never dismisses an observed toast on press, even after its outcome is in', async () => {
		const { id, current, press } = observedToast(async () => false);
		await press();
		useToast().dismissAfterAction(id);
		expect(current()?.message).toBe('Moved to Later. Not undone.');
	});

	it('does not bring the action back after its deadline, even before the overdue timer runs', async () => {
		const work = deferred<boolean | { retryable: true }>();
		const { current, press } = observedToast(() => work.promise);
		elapse(7000);
		const running = press();
		// The clock passes the deadline while no timer gets to run (a throttled tab).
		mono += 2000;
		work.resolve({ retryable: true });
		await running;
		expect(current()).toMatchObject({ message: 'Moved to Later. Not undone.' });
		expect(current()?.action).toBeUndefined();
	});

	it('does not run the action when pressed past its deadline before the timer runs', async () => {
		const run = vi.fn(async () => true);
		const { current, press } = observedToast(run);
		mono += 8000;
		await press();
		expect(run).not.toHaveBeenCalled();
		expect(current()).toBeUndefined();
	});

	it('does not stretch the window when the wall clock moves backward', async () => {
		const work = deferred<boolean | { retryable: true }>();
		const { current, press } = observedToast(() => work.promise);
		const running = press();
		vi.setSystemTime(Date.now() - 60_000);
		elapse(9000);
		work.resolve({ retryable: true });
		await running;
		// 9 s into an 8 s window: the action does not come back.
		expect(current()).toMatchObject({ message: 'Moved to Later. Not undone.' });
		expect(current()?.action).toBeUndefined();
	});

	it('does not cut the window when the wall clock moves forward', async () => {
		const run = vi.fn(async () => true);
		const { current, press } = observedToast(run);
		vi.setSystemTime(Date.now() + 60_000);
		elapse(1000);
		expect(current()?.action?.label).toBe('Undo');
		await press();
		expect(run).toHaveBeenCalledTimes(1);
		expect(current()).toBeUndefined();
	});

	it('keeps the original deadline for an action a retry brought back', async () => {
		const work = deferred<boolean | { retryable: true }>();
		const { current, press } = observedToast(() => work.promise);
		const running = press();
		elapse(1000);
		work.resolve({ retryable: true });
		await running;
		expect(current()).toMatchObject({ pending: false, action: { label: 'Undo' } });
		elapse(6999);
		expect(current()).toBeDefined();
		elapse(1);
		expect(current()).toBeUndefined();
	});

	it('removes an unpressed observed toast at its deadline, exactly like a plain one', () => {
		const run = vi.fn(async () => true);
		const { current } = observedToast(run);
		elapse(8000);
		expect(current()).toBeUndefined();
		expect(run).not.toHaveBeenCalled();
	});

	it('lets the close button remove a pending toast; the late outcome does not bring it back', async () => {
		const work = deferred<boolean>();
		const onDismiss = vi.fn();
		const { id, current, press } = observedToast(() => work.promise, { onDismiss });
		const running = press();
		useToast().removeToast(id);
		expect(current()).toBeUndefined();
		work.resolve(false);
		await running;
		expect(current()).toBeUndefined();
		expect(onDismiss).toHaveBeenCalledTimes(1);
	});
});
