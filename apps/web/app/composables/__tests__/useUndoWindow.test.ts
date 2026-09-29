import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

/**
 * The undo window every countdown toast is built on. The property the toasts
 * rely on: `runUndo` closes the window BEFORE it awaits the reversal, so a
 * second click landing while a slow mutation runs does nothing.
 */
const stateBuckets = new Map<string, ReturnType<typeof ref>>();
vi.stubGlobal('useState', (key: string, init: () => unknown) => {
	if (!stateBuckets.has(key)) stateBuckets.set(key, ref(init()));
	return stateBuckets.get(key);
});

import { useUndoWindow } from '../useUndoWindow';

interface TestWindow {
	token: string | null;
}

const useTestWindow = (key = 'test:undo') =>
	useUndoWindow<TestWindow>(key, () => ({ token: null }));

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

describe('useUndoWindow', () => {
	beforeEach(() => {
		stateBuckets.clear();
	});

	it('starts closed, opens on arm, closes on dismiss', () => {
		const { state, arm, dismiss } = useTestWindow();
		expect(state.value).toEqual({ token: null, visible: false, sendAt: 0 });

		arm({ token: 'abc', sendAt: 5000 });
		expect(state.value).toEqual({ token: 'abc', visible: true, sendAt: 5000 });

		dismiss();
		expect(state.value).toEqual({ token: null, visible: false, sendAt: 0 });
	});

	it('shares one window per key across callers', () => {
		useTestWindow().arm({ token: 'abc', sendAt: 5000 });
		expect(useTestWindow().state.value.token).toBe('abc');
		expect(useTestWindow('other:undo').state.value.visible).toBe(false);
	});

	it('runUndo dismisses before it awaits the handler', async () => {
		const { state, arm, runUndo } = useTestWindow();
		const gate = deferred();
		let visibleWhileRunning: boolean | undefined;
		arm({ token: 'abc', sendAt: 5000 }, async () => {
			visibleWhileRunning = state.value.visible;
			await gate.promise;
		});

		const running = runUndo();
		expect(state.value.visible).toBe(false);
		expect(visibleWhileRunning).toBe(false);
		gate.resolve();
		await running;
	});

	it('a double runUndo calls the handler once, even while the first is pending', async () => {
		const { arm, runUndo } = useTestWindow();
		const gate = deferred();
		const handler = vi.fn(() => gate.promise);
		arm({ token: 'abc', sendAt: 5000 }, handler);

		const first = runUndo();
		const second = runUndo();
		gate.resolve();
		await Promise.all([first, second]);
		expect(handler).toHaveBeenCalledTimes(1);
	});

	it('hands the fallback the window as it was when no handler was armed', async () => {
		const { state, arm, runUndo } = useTestWindow();
		const fallback = vi.fn();
		arm({ token: 'abc', sendAt: 5000 });

		await runUndo(fallback);
		expect(fallback).toHaveBeenCalledWith({ token: 'abc', visible: true, sendAt: 5000 });
		expect(state.value.visible).toBe(false);

		await runUndo(fallback);
		expect(fallback).toHaveBeenCalledTimes(1);
	});

	it('an armed handler wins over the fallback', async () => {
		const { arm, runUndo } = useTestWindow();
		const armed = vi.fn();
		const fallback = vi.fn();
		arm({ token: 'abc', sendAt: 5000 }, armed);

		await runUndo(fallback);
		expect(armed).toHaveBeenCalledTimes(1);
		expect(fallback).not.toHaveBeenCalled();
	});

	it('re-arming without a handler drops the previous window handler', async () => {
		const { arm, runUndo } = useTestWindow();
		const stale = vi.fn();
		arm({ token: 'first', sendAt: 5000 }, stale);
		arm({ token: 'second', sendAt: 6000 });

		await runUndo();
		expect(stale).not.toHaveBeenCalled();
	});

	it('dismiss drops the armed handler', async () => {
		const { arm, dismiss, runUndo } = useTestWindow();
		const handler = vi.fn();
		arm({ token: 'abc', sendAt: 5000 }, handler);
		dismiss();

		await runUndo();
		expect(handler).not.toHaveBeenCalled();
	});
});
