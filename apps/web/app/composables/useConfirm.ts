import { computed, getCurrentScope, onScopeDispose, shallowRef } from 'vue';

export type ConfirmVariant = 'danger' | 'warning' | 'default';

export interface ConfirmOptions {
	/** The question, e.g. "Permanently delete 3 messages?". */
	title: string;
	/** What saying yes does. Line breaks are kept; omitted, the dialog shows none. */
	body?: string;
	/** Defaults to the dialog's own "Confirm" / "Cancel". */
	confirmText?: string;
	cancelText?: string;
	variant?: ConfirmVariant;
}

export interface ConfirmRequest extends Readonly<ConfirmOptions> {
	readonly id: number;
}

interface PendingRequest {
	request: ConfirmRequest;
	owner: symbol;
	settle: (confirmed: boolean) => void;
}

// Module state is safe because the app is client-only (`ssr: false`): there is
// one queue per tab, never one shared between requests on a server.
const queue = shallowRef<readonly PendingRequest[]>([]);
let nextId = 1;
let hostCount = 0;

function settleWhere(match: (entry: PendingRequest) => boolean, confirmed: boolean): void {
	const settled = queue.value.filter(match);
	if (settled.length === 0) return;
	queue.value = queue.value.filter((entry) => !match(entry));
	for (const entry of settled) entry.settle(confirmed);
}

/**
 * Every open question, oldest first. The host shows the head and the rest wait
 * their turn, so two callers asking at once get two dialogs one after the
 * other rather than the second replacing the first.
 */
export const pendingConfirms = computed<readonly ConfirmRequest[]>(() =>
	queue.value.map((entry) => entry.request)
);

/**
 * The host's answer to one request. Only the request on screen (the head) can
 * be answered, and only once: a late or repeated click is ignored.
 */
export function respondToConfirm(id: number, confirmed: boolean): void {
	if (queue.value[0]?.request.id !== id) return;
	settleWhere((entry) => entry.request.id === id, confirmed);
}

/**
 * Called by `ConfirmDialogHost` while it is mounted. When the last host goes,
 * every open question is answered "no": a destructive action never runs on an
 * answer nobody could give, and no caller is left awaiting forever.
 */
export function registerConfirmHost(): () => void {
	hostCount += 1;
	let registered = true;
	return () => {
		if (!registered) return;
		registered = false;
		hostCount -= 1;
		if (hostCount === 0) settleWhere(() => true, false);
	};
}

/**
 * Ask the person before doing something they cannot easily take back, in the
 * app's own dialog instead of the browser's unstyled `window.confirm`:
 *
 *     const confirm = useConfirm();
 *     if (!(await confirm({ title, body, variant: 'danger' }))) return;
 *
 * Resolves `true` only on the confirm button. Cancel, Escape, the backdrop
 * and the close button resolve `false`.
 *
 * Call it in setup. A question still open when the caller's scope is disposed
 * (the component unmounted, the route changed) is withdrawn and resolves
 * `false`, so a confirmation can never land on a page that no longer shows
 * what it was about. Each caller has at most one open question: asking again
 * while one is on screen (a double click, a shortcut pressed twice) resolves
 * `false` at once instead of queueing the same destructive action twice.
 *
 * Read everything the action needs (ids, the current selection) before
 * awaiting: the answer comes back later, and by then the live values may
 * point somewhere else.
 *
 * Dialogs whose body is more than text (a form, a list, a typed name to
 * match) stay declarative with `<UiConfirmationDialog>`.
 */
export function useConfirm(): (options: ConfirmOptions) => Promise<boolean> {
	const owner = Symbol('confirm caller');
	if (getCurrentScope()) {
		onScopeDispose(() => settleWhere((entry) => entry.owner === owner, false));
	}
	return (options) => {
		if (hostCount === 0) {
			// Never reached in the app: app.vue mounts the host for every page.
			// Failing closed keeps a missing host from confirming anything.
			if (import.meta.dev) console.warn('[confirm] no ConfirmDialogHost is mounted; answering no.');
			return Promise.resolve(false);
		}
		if (queue.value.some((entry) => entry.owner === owner)) return Promise.resolve(false);
		return new Promise<boolean>((settle) => {
			const request: ConfirmRequest = { ...options, id: nextId++ };
			queue.value = [...queue.value, { request, owner, settle }];
		});
	};
}
