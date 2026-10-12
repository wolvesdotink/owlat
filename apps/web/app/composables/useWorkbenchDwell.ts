import { onBeforeUnmount, watch, type Ref } from 'vue';

/** How long a tab's summary has to be on screen before leaving it counts as seen. */
export const WORKBENCH_DWELL_MS = 30_000;

/**
 * The Workbench's quiet "mark as seen": a deliberate stay of at least half a
 * minute on a tab, counted when the viewer leaves it (another tab, another
 * page). Only time the tab's own summary was actually on screen counts: not
 * while the previous tab is still showing as the next one loads, not while the
 * tab has nothing to show, and not while Zen mode hides the bands. Hidden
 * updates are never acknowledged: the watermark moves only as far as the
 * server time of the last snapshot that was on screen (`asOf`), so mail that
 * arrived while the summary was hidden stays new, whatever the browser's clock
 * says. The half minute itself is measured locally, where skew cancels out.
 */
export function useWorkbenchDwell<S extends string>(opts: {
	scope: Ref<S | null>;
	/** This tab's summary is on screen and has something in it. */
	showing: Ref<boolean>;
	/** Server time of the snapshot on screen; null when there is none. */
	asOf: Ref<number | null>;
	/** `at`: the server time of the last snapshot that was on screen. */
	markSeen: (scope: S, at: number) => void;
	now?: () => number;
}) {
	const now = opts.now ?? Date.now;
	let shownMs = 0;
	let shownSince: number | null = null;
	let lastShownAsOf: number | null = null;

	function pause() {
		if (shownSince !== null) shownMs += now() - shownSince;
		shownSince = null;
	}

	function leave(scope: S | null) {
		pause();
		if (scope && lastShownAsOf !== null && shownMs >= WORKBENCH_DWELL_MS)
			opts.markSeen(scope, lastShownAsOf);
		shownMs = 0;
		lastShownAsOf = null;
	}

	watch(
		[opts.scope, opts.showing, opts.asOf],
		([scope, showing, asOf], previous) => {
			const [previousScope, previousShowing, previousAsOf] = previous ?? [null, false, null];
			// The snapshot that was on screen until this change.
			if (previous && previousShowing && previousAsOf != null) lastShownAsOf = previousAsOf;
			if (previous && scope !== previousScope) leave(previousScope ?? null);
			else pause();
			if (scope && showing) {
				shownSince = now();
				if (asOf !== null) lastShownAsOf = asOf;
			}
		},
		{ immediate: true }
	);
	onBeforeUnmount(() => leave(opts.scope.value));
}
