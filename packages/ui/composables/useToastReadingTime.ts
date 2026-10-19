import { effectScope, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue';

/**
 * Reading time for ordinary notification toasts.
 *
 * A one-shot timer started by `showToast` keeps counting while nobody can read
 * the toast, so a "Saved" or a warning can expire in a hidden tab, behind
 * another desktop window, or while the pointer rests on it. An ordinary toast
 * instead gets a budget of `durationMs` that only runs while it can be read:
 * it pauses while the card is hovered or holds focus, while the document is
 * hidden and while the window is unfocused, then resumes with what was left.
 * A toast that stays visible and untouched still goes after exactly
 * `durationMs`.
 *
 * Toasts with an action (an "Undo") are deliberately not counted this way:
 * their lifetime is the window in which the action may still run, and pausing
 * it would stretch that window. They keep the one-shot timer in `useToast`.
 */

/**
 * The options an ordinary toast may carry. Any other option set to a value
 * (`action` today, any action-like option added later) keeps the toast on the
 * one-shot timer, so a new action kind can never get a stretched deadline by
 * accident.
 */
const ORDINARY_TOAST_OPTIONS: ReadonlySet<string> = new Set(['durationMs', 'onDismiss']);

/** Does a toast shown with these options count reading time? */
export function isReadingTimeToast(options: object | undefined): boolean {
	if (!options) return true;
	return Object.entries(options).every(
		([key, value]) => value === undefined || ORDINARY_TOAST_OPTIONS.has(key)
	);
}

/** Why a single card holds its own budget. */
type CardHold = 'hover' | 'focus';

interface ReadingBudget {
	/** Reading time still owed while the budget is paused, in ms. */
	remainingMs: number;
	/** When the running stretch began on the monotonic clock; `null` while paused. */
	runningSince: number | null;
	timer: ReturnType<typeof setTimeout> | undefined;
	holds: Set<CardHold>;
	onExpire: () => void;
	/** Stops watching whether the toast is still listed. */
	stopWatching: () => void;
}

const budgets = new Map<string, ReadingBudget>();

/**
 * Elapsed reading time is measured on the monotonic clock: a wall-clock jump
 * (NTP correction, the user changing the time, a laptop waking up) must not
 * shorten or stretch what is left.
 */
function now(): number {
	return performance.now();
}

/** The page can be read: the document is visible and its window has focus. */
let pageReadable = true;

function readPageReadable(): boolean {
	if (typeof document === 'undefined') return true;
	if (document.hidden) return false;
	return typeof document.hasFocus === 'function' ? document.hasFocus() : true;
}

/** Start or stop the budget's clock to match its holds and the page state. */
function sync(id: string, budget: ReadingBudget): void {
	const shouldRun = pageReadable && budget.holds.size === 0;
	if (shouldRun && budget.runningSince === null) {
		budget.runningSince = now();
		budget.timer = setTimeout(() => expire(id), budget.remainingMs);
	} else if (!shouldRun && budget.runningSince !== null) {
		budget.remainingMs = Math.max(0, budget.remainingMs - (now() - budget.runningSince));
		budget.runningSince = null;
		clearTimeout(budget.timer);
		budget.timer = undefined;
	}
}

/** Drop the budget for good: no timer, no list watcher, no page listeners once none is left. */
function discard(id: string): ReadingBudget | undefined {
	const budget = budgets.get(id);
	if (!budget) return undefined;
	budgets.delete(id);
	clearTimeout(budget.timer);
	budget.stopWatching();
	if (budgets.size === 0) unwatchPage();
	return budget;
}

function expire(id: string): void {
	discard(id)?.onExpire();
}

function onPageChange(): void {
	pageReadable = readPageReadable();
	for (const [id, budget] of budgets) sync(id, budget);
}

let watchingPage = false;

function watchPage(): void {
	if (watchingPage || typeof window === 'undefined') return;
	watchingPage = true;
	document.addEventListener('visibilitychange', onPageChange);
	window.addEventListener('blur', onPageChange);
	window.addEventListener('focus', onPageChange);
}

function unwatchPage(): void {
	if (!watchingPage) return;
	watchingPage = false;
	document.removeEventListener('visibilitychange', onPageChange);
	window.removeEventListener('blur', onPageChange);
	window.removeEventListener('focus', onPageChange);
}

/**
 * Give toast `id` a reading-time budget of `durationMs`, calling `onExpire`
 * once it has been readable that long. A non-positive or non-finite duration
 * is a sticky toast: no budget, nothing expires.
 *
 * `isListed` reports whether the toast is still in the stack. The moment it
 * is not (closed, cleared, removed before its card ever rendered) the budget
 * is dropped, so a dismissed toast leaves no timer or page listener behind.
 */
export function startToastReadingTime(
	id: string,
	durationMs: number,
	onExpire: () => void,
	isListed: () => boolean
): void {
	if (!(Number.isFinite(durationMs) && durationMs > 0)) return;
	watchPage();
	pageReadable = readPageReadable();
	// Detached, so a toast shown during some component's setup is not left
	// unwatched when that component unmounts.
	const scope = effectScope(true);
	scope.run(() =>
		watch(
			isListed,
			(listed) => {
				if (!listed) discard(id);
			},
			{ flush: 'sync' }
		)
	);
	const budget: ReadingBudget = {
		remainingMs: durationMs,
		runningSince: null,
		timer: undefined,
		holds: new Set(),
		onExpire,
		stopWatching: () => scope.stop(),
	};
	budgets.set(id, budget);
	sync(id, budget);
}

function setHold(id: string, hold: CardHold, held: boolean): void {
	const budget = budgets.get(id);
	if (!budget) return;
	if (held) budget.holds.add(hold);
	else budget.holds.delete(hold);
	sync(id, budget);
}

/**
 * Pause toast `id`'s reading time while its card is hovered or holds focus.
 * Bind the returned ref to the card element. Toasts without a budget (action
 * toasts, sticky toasts) ignore the holds. Touch has no hover, so only a
 * mouse or pen pointer counts.
 */
export function useToastReadingTimeHolds(id: () => string): Ref<HTMLElement | null> {
	const card = ref<HTMLElement | null>(null);

	const onPointerEnter = (event: PointerEvent) => {
		if (event.pointerType !== 'touch') setHold(id(), 'hover', true);
	};
	const onPointerLeave = () => setHold(id(), 'hover', false);
	const onFocusIn = () => setHold(id(), 'focus', true);
	const onFocusOut = (event: FocusEvent) => {
		const next = event.relatedTarget;
		if (next instanceof Node && card.value?.contains(next)) return;
		setHold(id(), 'focus', false);
	};

	onMounted(() => {
		const el = card.value;
		if (!el) return;
		el.addEventListener('pointerenter', onPointerEnter);
		el.addEventListener('pointerleave', onPointerLeave);
		el.addEventListener('focusin', onFocusIn);
		el.addEventListener('focusout', onFocusOut);
	});

	onBeforeUnmount(() => {
		const el = card.value;
		if (el) {
			el.removeEventListener('pointerenter', onPointerEnter);
			el.removeEventListener('pointerleave', onPointerLeave);
			el.removeEventListener('focusin', onFocusIn);
			el.removeEventListener('focusout', onFocusOut);
		}
		setHold(id(), 'hover', false);
		setHold(id(), 'focus', false);
	});

	return card;
}
