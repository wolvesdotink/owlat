/**
 * Team Inbox auto-close on the web: the settings form's bounds (the same as
 * the backend's, `inbox/autoCloseRules.ts`) and what the thread page says
 * about one thread's auto-close state (`inbox/autoClose.ts`
 * `getThreadAutoClose`). Pure.
 */

export const AUTO_CLOSE_MIN_DAYS = 1;
export const AUTO_CLOSE_MAX_DAYS = 365;
/** What the settings form shows before anything was saved. */
export const AUTO_CLOSE_DEFAULT_DAYS = 7;

/** The editable rule: on or off, and the quiet days. */
export interface AutoClosePolicyShape {
	isEnabled: boolean;
	quietDays: number;
}

/** True when `quietDays` is not a whole number of days the backend accepts. */
export function autoCloseDaysProblem(quietDays: number): boolean {
	return (
		!Number.isInteger(quietDays) ||
		quietDays < AUTO_CLOSE_MIN_DAYS ||
		quietDays > AUTO_CLOSE_MAX_DAYS
	);
}

/** One thread's state as `getThreadAutoClose` returns it. */
export interface ThreadAutoCloseView {
	isPolicyEnabled: boolean;
	quietDays: number | null;
	isDisabledForThread: boolean;
	dueAt: number | null;
	autoClosedAt: number | null;
}

/**
 * The thread's own switch: `on` or `off`, or `null` when there is nothing to
 * switch (the rule is off and the thread never opted out).
 */
export function threadAutoCloseSwitch(view: ThreadAutoCloseView | null): 'on' | 'off' | null {
	if (!view) return null;
	if (view.isDisabledForThread) return 'off';
	return view.isPolicyEnabled ? 'on' : null;
}

/** The line the details card shows under "Auto-close", as an i18n key and its params. */
export type ThreadAutoCloseFact =
	| { key: 'dashboard.inbox.detail.autoClose.off' }
	| { key: 'dashboard.inbox.detail.autoClose.closesAt'; dueAt: number }
	| { key: 'dashboard.inbox.detail.autoClose.onWhenWaiting'; days: number };

export function threadAutoCloseFact(view: ThreadAutoCloseView | null): ThreadAutoCloseFact | null {
	const state = threadAutoCloseSwitch(view);
	if (!view || state === null) return null;
	if (state === 'off') return { key: 'dashboard.inbox.detail.autoClose.off' };
	if (view.dueAt !== null)
		return { key: 'dashboard.inbox.detail.autoClose.closesAt', dueAt: view.dueAt };
	if (view.quietDays === null) return null;
	return { key: 'dashboard.inbox.detail.autoClose.onWhenWaiting', days: view.quietDays };
}

/** The current resolve was the sweep's, not a person's. */
export function isAutoClosed(
	thread: { status: string; autoClosedAt?: number | null } | null | undefined
): boolean {
	return (
		!!thread &&
		thread.autoClosedAt != null &&
		(thread.status === 'resolved' || thread.status === 'closed')
	);
}
