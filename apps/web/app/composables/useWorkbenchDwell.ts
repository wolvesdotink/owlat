import { onBeforeUnmount, watch, type Ref } from 'vue';

/** How long a tab's summary has to be on screen before leaving it counts as seen. */
export const WORKBENCH_DWELL_MS = 30_000;

/**
 * The Workbench's quiet "mark as seen": a deliberate stay of at least half a
 * minute on a tab, counted when the viewer leaves it (another tab, another
 * page). Only time the tab's own summary was actually on screen counts: not
 * while the previous tab is still showing as the next one loads, not while the
 * tab has nothing to show, and not while Zen mode hides the bands. Hidden
 * updates are never acknowledged.
 */
export function useWorkbenchDwell<S extends string>(opts: {
	scope: Ref<S | null>;
	/** This tab's summary is on screen and has something in it. */
	showing: Ref<boolean>;
	markSeen: (scope: S) => void;
	now?: () => number;
}) {
	const now = opts.now ?? Date.now;
	let shownMs = 0;
	let shownSince: number | null = null;

	function pause() {
		if (shownSince !== null) shownMs += now() - shownSince;
		shownSince = null;
	}

	function leave(scope: S | null) {
		pause();
		if (scope && shownMs >= WORKBENCH_DWELL_MS) opts.markSeen(scope);
		shownMs = 0;
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
