/**
 * Sweep: press a row's checkbox or hover Archive (or Dismiss) button and drag
 * across the list to apply that one action to every row the pointer passes.
 * The pointer bookkeeping lives in `usePostboxSweep`; these are the pure parts,
 * so the range math and the row hit-test are tested without a mounted list.
 * The Postbox lists, the all-inboxes list and Team Updates share them.
 */

/** Movement that turns a press on a sweep handle into a sweep; less is a click. */
export const POSTBOX_SWEEP_START_PX = 5;

/**
 * The handles a sweep can start from. `dismiss` is Team Updates' own verb (a
 * terminal lifecycle step with no Undo), kept apart from mail's `archive`.
 */
export type PostboxSweepKind = 'select' | 'archive' | 'dismiss';

/**
 * What a sweep does to each row it covers. A checkbox sweep takes its direction
 * from the row it started on: from an unticked box it selects, from a ticked
 * one it deselects, the way a click on that box would have.
 */
export type PostboxSweepMark = 'select' | 'deselect' | 'archive' | 'dismiss';

export function postboxSweepMark(
	kind: PostboxSweepKind,
	originSelected: boolean
): PostboxSweepMark {
	if (kind !== 'select') return kind;
	return originSelected ? 'deselect' : 'select';
}

/**
 * Only a plain primary-button mouse press starts a sweep. Touch and pen drags
 * already mean scroll and swipe on these rows, and a modified click keeps its
 * own meaning (Shift extends the selection from the anchor).
 */
export function isPostboxSweepPress(event: {
	pointerType: string;
	button: number;
	isPrimary: boolean;
	shiftKey: boolean;
	metaKey: boolean;
	ctrlKey: boolean;
	altKey: boolean;
}): boolean {
	return (
		event.pointerType === 'mouse' &&
		event.button === 0 &&
		event.isPrimary &&
		!event.shiftKey &&
		!event.metaKey &&
		!event.ctrlKey &&
		!event.altKey
	);
}

/**
 * The rows from `originId` to `targetId` inclusive, in list order whichever way
 * round they are, keeping only the rows the action applies to. Unlike
 * Shift+click's `rangeBetween`, a missing origin yields nothing: the row the
 * press started on was removed mid-sweep, and acting on a range with no start
 * would act on rows the person never pointed at.
 */
export function postboxSweepRange<T extends string>(
	orderedIds: readonly T[],
	originId: string,
	targetId: string,
	canApply: (id: T) => boolean = () => true
): T[] {
	const origin = orderedIds.indexOf(originId as T);
	const target = orderedIds.indexOf(targetId as T);
	if (origin < 0 || target < 0) return [];
	return orderedIds
		.slice(Math.min(origin, target), Math.max(origin, target) + 1)
		.filter((id) => canApply(id));
}

/**
 * The row under a pointer at `y`, from the rendered rows' tops in DOM order.
 * Only the vertical position counts, so a pointer that drifts sideways off the
 * list keeps sweeping the row level with it; above the first row it is the
 * first row and below the last it is the last.
 */
export function postboxSweepRowAtY(
	rows: readonly { id: string; top: number }[],
	y: number
): string | null {
	let hit: string | null = null;
	for (const row of rows) {
		if (hit !== null && row.top > y) break;
		hit = row.id;
	}
	return hit;
}

/**
 * The row half of a sweep's start. A press that lands on a sweep handle (an
 * element carrying `data-sweep-handle="select" | "archive"`) is reported to
 * `onStart`, and the row's native drag is refused for that press: the row is
 * `draggable`, so a drag from its checkbox would otherwise pick the whole row
 * up for the folder rail instead of sweeping.
 */
export function createPostboxSweepHandle(
	onStart: (kind: 'select' | 'archive', event: PointerEvent) => void
) {
	let pressOnHandle = false;
	return {
		onPointerdown(event: PointerEvent) {
			const target = event.target as Element | null;
			const kind = target?.closest?.<HTMLElement>('[data-sweep-handle]')?.dataset['sweepHandle'];
			pressOnHandle = kind === 'select' || kind === 'archive';
			if (kind === 'select' || kind === 'archive') onStart(kind, event);
		},
		/** Cancels the row's drag when the press began on a handle; true if it did. */
		claimsDrag(event: DragEvent): boolean {
			if (!pressOnHandle) return false;
			event.preventDefault();
			return true;
		},
	};
}
