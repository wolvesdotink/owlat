/**
 * The two Postbox timings of plan 0.2, on top of `usePerfMark`:
 *
 *  - `owlat_reader_open_ms`: a navigation to a message (a row click, Enter,
 *    j / k) until the opened message's body has rendered in the reader;
 *  - `owlat_back_list_ms`: a navigation from the reader back to the same
 *    folder's list until the list shows its rows (or its settled empty state).
 *
 * A router guard classifies the move, but a global guard runs only after the
 * route middleware (auth) has settled. So the span starts at the input event
 * that asked for the move (the click or key press, when there was one in the
 * last second) and covers the route resolution as well. The layout registers
 * the guard while it is mounted; the body side is a plain call from
 * `PostboxMessageBody` (see `notePostboxBodyRendered`), which is why the
 * pending open lives at module level instead of in the layout's scope.
 *
 * Only moves inside the Postbox page are timed. Arriving from another section
 * would fold that page's own mount into the number, and the Today overlay opens
 * without a navigation. Reporting goes through `lib/perfTelemetry`, so nothing
 * leaves the browser unless PostHog is configured and `analytics.posthog` is on.
 */
import type { RouteLocationNormalized } from 'vue-router';
import { onScopeDispose, watch, type Ref } from 'vue';
import { usePerfMark } from '~/composables/usePerfMark';

const POSTBOX_READER_OPEN_METRIC = 'owlat_reader_open_ms';
const POSTBOX_BACK_LIST_METRIC = 'owlat_back_list_ms';
const READER_OPEN_START = 'owlat_reader_open_start';
const BACK_LIST_START = 'owlat_back_list_start';

/** Frames to wait for the list's rows before giving the sample up (~5 s). */
const LIST_POLL_FRAMES = 300;
/** An input older than this did not start the navigation (browser back, a timer). */
const INPUT_WINDOW_MS = 1000;

/** The message a timed open is waiting on, or null. */
let pendingOpenId: string | null = null;

type PostboxRoute = Pick<RouteLocationNormalized, 'name' | 'params'>;

function param(route: PostboxRoute, key: string): string | null {
	const value = route.params[key];
	return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * What a navigation between two Postbox routes is, for timing: an open of a
 * (different) message, a return from the reader to the same folder's list, or
 * neither (a folder switch, a query change, another page).
 */
export function classifyPostboxNav(to: PostboxRoute, from: PostboxRoute): 'open' | 'back' | null {
	if (to.name == null || to.name !== from.name) return null;
	const toMessage = param(to, 'messageId');
	const fromMessage = param(from, 'messageId');
	if (toMessage) return toMessage !== fromMessage ? 'open' : null;
	if (fromMessage && param(to, 'folder') === param(from, 'folder')) return 'back';
	return null;
}

/** Same page, folder and message: only the query (or hash) differs. */
function samePostboxView(to: PostboxRoute, from: PostboxRoute): boolean {
	return (
		to.name === from.name &&
		param(to, 'folder') === param(from, 'folder') &&
		param(to, 'messageId') === param(from, 'messageId')
	);
}

/**
 * Start timing an open of `messageId`, now or at `startTime`; a later open
 * replaces it.
 */
function notePostboxReaderOpen(messageId: string, startTime?: number): void {
	pendingOpenId = messageId;
	usePerfMark().mark(READER_OPEN_START, startTime);
}

/**
 * The body of `messageId` is on screen (its frame document is parsed). Ends the
 * pending open when it is for this message; any other body is ignored.
 */
export function notePostboxBodyRendered(messageId: string | undefined): void {
	if (!messageId || messageId !== pendingOpenId) return;
	pendingOpenId = null;
	usePerfMark().measure(POSTBOX_READER_OPEN_METRIC, READER_OPEN_START);
}

/** Drop a pending open (a navigation that is not an open, or the layout left). */
function forgetPostboxReaderOpen(): void {
	pendingOpenId = null;
}

/**
 * The list pane shows what it will show: at least one row, or no first-load
 * skeleton (an empty folder's settled state). Rows in every renderer are
 * `role="option"`.
 */
export function postboxListRendered(pane: HTMLElement): boolean {
	if (pane.querySelector('[role="option"]')) return true;
	return !pane.querySelector('[data-testid="postbox-thread-list-skeleton"]');
}

/**
 * Wire both timings for the Postbox layout: the router guard that starts them,
 * and the list side of the back timing, which waits (one check per animation
 * frame) until the list pane has rendered its rows after the reader closed.
 */
export function usePostboxPerfMarks(args: {
	activeMessageId: () => string | null | undefined;
	listPane: Ref<HTMLElement | null>;
}): void {
	const { mark, measure } = usePerfMark();
	let backPending = false;
	let pollHandle: number | null = null;
	let lastInputAt: number | null = null;

	// The click or key press behind the next navigation (capture phase, so a
	// row's own handlers cannot hide it).
	function onInput(event: Event): void {
		lastInputAt = event.timeStamp;
	}
	function inputStart(): number | undefined {
		const at = lastInputAt;
		lastInputAt = null;
		if (at === null || typeof performance === 'undefined') return undefined;
		const age = performance.now() - at;
		return age >= 0 && age < INPUT_WINDOW_MS ? at : undefined;
	}
	if (typeof document !== 'undefined') {
		document.addEventListener('click', onInput, true);
		document.addEventListener('keydown', onInput, true);
	}

	function stopPolling(): void {
		if (pollHandle !== null && typeof cancelAnimationFrame === 'function') {
			cancelAnimationFrame(pollHandle);
		}
		pollHandle = null;
	}

	function pollList(framesLeft: number): void {
		pollHandle = null;
		const pane = args.listPane.value;
		if (pane && postboxListRendered(pane)) {
			measure(POSTBOX_BACK_LIST_METRIC, BACK_LIST_START);
			return;
		}
		if (framesLeft <= 1) return;
		pollHandle = requestAnimationFrame(() => pollList(framesLeft - 1));
	}

	const removeGuard = useRouter().beforeEach((to, from) => {
		// A query-only change of the same view (a filter, a compose param) is
		// not a move: whatever is being timed keeps running.
		if (samePostboxView(to, from)) return;
		const kind = classifyPostboxNav(to, from);
		const startTime = inputStart();
		stopPolling();
		backPending = kind === 'back';
		if (kind === 'open') notePostboxReaderOpen(param(to, 'messageId')!, startTime);
		else forgetPostboxReaderOpen();
		if (kind === 'back') mark(BACK_LIST_START, startTime);
	});

	// The reader closed: from the next frame on, wait for the list's rows.
	watch(
		args.activeMessageId,
		(id) => {
			if (id || !backPending || typeof requestAnimationFrame !== 'function') return;
			backPending = false;
			pollHandle = requestAnimationFrame(() => pollList(LIST_POLL_FRAMES));
		},
		{ flush: 'post' }
	);

	onScopeDispose(() => {
		if (typeof document !== 'undefined') {
			document.removeEventListener('click', onInput, true);
			document.removeEventListener('keydown', onInput, true);
		}
		removeGuard();
		stopPolling();
		forgetPostboxReaderOpen();
	});
}
