import { onBeforeUnmount, watch, type Ref } from 'vue';

/** How long a tab's summary has to be on screen before leaving it counts as seen. */
export const WORKBENCH_DWELL_MS = 30_000;

/**
 * The Workbench's quiet "mark as seen": a deliberate stay of at least half a
 * minute on a tab, counted when the viewer leaves it (another tab, another
 * page). Only time the tab's own summary was actually on screen counts: not
 * while the previous tab is still showing as the next one loads, not while the
 * tab has nothing to show, and not while Zen mode hides the bands. Hidden
 * updates are never acknowledged: the watermark moves only as far as the last
 * moment the summary was on screen, so mail that arrived while it was hidden
 * stays new.
 */
export function useWorkbenchDwell<S extends string>(opts: {
	scope: Ref<S | null>;
	/** This tab's summary is on screen and has something in it. */
	showing: Ref<boolean>;
	/** `at`: the last moment the summary was on screen. */
	markSeen: (scope: S, at: number) => void;
	now?: () => number;
}) {
	const now = opts.now ?? Date.now;
	let shownMs = 0;
	let shownSince: number | null = null;
	let lastShownAt: number | null = null;

	function pause() {
		if (shownSince !== null) {
			lastShownAt = now();
			shownMs += lastShownAt - shownSince;
		}
		shownSince = null;
	}

	function leave(scope: S | null) {
		pause();
		if (scope && lastShownAt !== null && shownMs >= WORKBENCH_DWELL_MS)
			opts.markSeen(scope, lastShownAt);
		shownMs = 0;
		lastShownAt = null;
	}

	watch(
		[opts.scope, opts.showing],
		([scope, showing], previous) => {
			const [previousScope] = previous ?? [null];
			if (previous && scope !== previousScope) leave(previousScope ?? null);
			else pause();
			if (scope && showing) shownSince = now();
		},
		{ immediate: true }
	);
	onBeforeUnmount(() => leave(opts.scope.value));
}
