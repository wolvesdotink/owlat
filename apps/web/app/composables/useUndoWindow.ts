/**
 * One undo window: the few seconds in which an action that already went out
 * (a mail send, a campaign send, a review approve) can still be called back.
 *
 * The state is a `useState` singleton per key, so the surface that armed the
 * window can unmount or navigate away and the toast, mounted elsewhere, still
 * knows what is in flight and until when. Arming again replaces the previous
 * window.
 *
 * Only serializable data lives in the state. The undo callback, when the
 * arming surface has one, is kept beside it in a module map (functions do not
 * belong in `useState`), the same split useToast keeps between its toast list
 * and its dismiss handlers.
 *
 * `runUndo` claims the window before it awaits anything: it snapshots the
 * state, dismisses, then runs the handler with the snapshot. A second click
 * that lands while a slow mutation is still running finds the window closed
 * and does nothing.
 */

type UndoWindowState<T extends object> = T & {
	visible: boolean;
	/** Epoch ms the held action fires; drives the countdown. */
	sendAt: number;
};

type UndoWindowHandler<T extends object> = (held: UndoWindowState<T>) => unknown;

const handlers = new Map<string, UndoWindowHandler<never>>();

export function useUndoWindow<T extends object>(key: string, empty: () => T) {
	const closed = (): UndoWindowState<T> => ({ ...empty(), visible: false, sendAt: 0 });
	const state = useState<UndoWindowState<T>>(key, closed);

	/**
	 * Open the window. `onUndo` is the arming surface's inverse; leave it out
	 * when the toast owns the reversal and passes it to `runUndo` instead.
	 */
	function arm(args: T & { sendAt: number }, onUndo?: UndoWindowHandler<T>) {
		state.value = { ...args, visible: true };
		if (onUndo) handlers.set(key, onUndo as UndoWindowHandler<never>);
		else handlers.delete(key);
	}

	function dismiss() {
		state.value = closed();
		handlers.delete(key);
	}

	/**
	 * Undo the open window: dismiss first, then run the armed handler (or
	 * `fallback` when nothing was armed) with the window as it was. Does
	 * nothing once the window is closed, so it can never fire twice.
	 */
	async function runUndo(fallback?: UndoWindowHandler<T>): Promise<void> {
		if (!state.value.visible) return;
		const held = state.value;
		const handler = (handlers.get(key) as UndoWindowHandler<T> | undefined) ?? fallback;
		dismiss();
		if (handler) await handler(held);
	}

	return { state, arm, dismiss, runUndo };
}
