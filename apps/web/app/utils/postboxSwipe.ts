/**
 * Swipe-to-triage on a Postbox thread row (UX plan idea 21) — all of the
 * geometry, none of the DOM.
 *
 * On a phone the only routes to a triage verb were the hover-reveal buttons
 * (which need a pointer that can hover) and the right-click menu (which needs a
 * right-click). The long-press menu closed half of that gap; this closes the
 * other half: drag a row sideways and it archives or snoozes.
 *
 * Everything decidable without a pointer lives here so it can be tested without
 * mounting a Convex-backed list: which action a given horizontal displacement
 * belongs to, whether the drag has travelled far enough (or fast enough) to
 * commit, how far the row is allowed to follow the finger, and how much of the
 * reveal track is showing. `usePostboxRowGestures` owns the pointer events and
 * calls into this module; the row renders what it returns.
 *
 * TWO RULES SHAPE THE NUMBERS.
 *
 *  1. The gesture must not fight the list's vertical scroll. A drag only claims
 *     the pointer once it is unambiguously horizontal ({@link classifySwipeIntent}),
 *     and a drag that starts vertical is abandoned for good rather than
 *     re-evaluated at every move — otherwise a diagonal flick down a long folder
 *     hijacks the scroll halfway through.
 *  2. A triage verb fired by accident is expensive, so the commit distance is
 *     deliberately past the point of "did I mean that". The velocity path
 *     ({@link POSTBOX_SWIPE_FLING_VELOCITY}) exists for the deliberate flick,
 *     which is fast AND still travels a fair way — not for a twitch.
 */

/**
 * What a swipe in one direction does. `'none'` is a real choice, not a null
 * state: a user who wants one direction inert (or swipe off entirely) picks it,
 * and the row then never claims a horizontal drag on that side.
 */
export type PostboxSwipeAction = 'archive' | 'trash' | 'snooze' | 'star' | 'read' | 'none';

/** Which way the row was dragged. Left = towards the start of the row. */
export type PostboxSwipeDirection = 'left' | 'right';

const SWIPE_ACTIONS = new Set<string>([
	'archive',
	'trash',
	'snooze',
	'star',
	'read',
	'none',
] satisfies PostboxSwipeAction[]);

/**
 * Drag left to archive, right to snooze — the mapping the plan names, and what
 * an unset preference resolves to on both sides of the wire.
 *
 * Unlike most Postbox preferences there is no older behaviour to preserve here:
 * rows had no touch verbs at all before this existed, so "absent" cannot mean
 * "what it did yesterday". It means the default mapping, and a user who wants
 * neither sets both sides to `'none'`.
 */
export const POSTBOX_SWIPE_LEFT_DEFAULT: PostboxSwipeAction = 'archive';
export const POSTBOX_SWIPE_RIGHT_DEFAULT: PostboxSwipeAction = 'snooze';

/** Normalise a stored/unknown value, defaulting to the direction's own default. */
export function resolvePostboxSwipeAction(
	value: string | undefined | null,
	fallback: PostboxSwipeAction
): PostboxSwipeAction {
	return typeof value === 'string' && SWIPE_ACTIONS.has(value)
		? (value as PostboxSwipeAction)
		: fallback;
}

/**
 * The picker options, in the order the settings card renders them. Module scope
 * never calls `useI18n`, so `label` is a catalog key resolved at the render
 * boundary.
 */
export const POSTBOX_SWIPE_ACTION_OPTIONS: ReadonlyArray<{
	readonly value: PostboxSwipeAction;
	readonly label: string;
}> = [
	{ value: 'archive', label: 'shared.postboxSwipe.actions.archive' },
	{ value: 'snooze', label: 'shared.postboxSwipe.actions.snooze' },
	{ value: 'trash', label: 'shared.postboxSwipe.actions.trash' },
	{ value: 'star', label: 'shared.postboxSwipe.actions.star' },
	{ value: 'read', label: 'shared.postboxSwipe.actions.read' },
	{ value: 'none', label: 'shared.postboxSwipe.actions.none' },
];

/** The semantic colours a track can fill with — theme tokens, not raw values. */
export type PostboxSwipeTone = 'brand' | 'error' | 'warning' | 'info';

/**
 * How the reveal track paints for each action: the icon that slides in behind
 * the row, and the tone the track fills with. Naming the tone rather than the
 * colour keeps the gesture inside the theme, and keeps this module free of
 * Tailwind class strings the scanner would have to see (the track component
 * spells those out).
 */
export const POSTBOX_SWIPE_VISUALS: Readonly<
	Record<
		Exclude<PostboxSwipeAction, 'none'>,
		{ readonly icon: string; readonly tone: PostboxSwipeTone }
	>
> = {
	archive: { icon: 'lucide:archive', tone: 'brand' },
	trash: { icon: 'lucide:trash', tone: 'error' },
	snooze: { icon: 'lucide:clock', tone: 'warning' },
	star: { icon: 'lucide:star', tone: 'warning' },
	read: { icon: 'lucide:mail-open', tone: 'info' },
};

/**
 * How far a pointer must travel before the gesture claims it. Small enough that
 * the row starts following the finger while the intent still reads as a drag,
 * large enough that a tap with a wobble in it is still a tap.
 */
export const POSTBOX_SWIPE_SLOP_PX = 12;

/**
 * How much more horizontal than vertical the movement has to be for a swipe to
 * win the pointer. A 1.4 ratio means a 45° diagonal scrolls (the safe outcome)
 * and only a clearly sideways drag triages.
 */
export const POSTBOX_SWIPE_DOMINANCE = 1.4;

/** Displacement at which a released drag commits its action. */
export const POSTBOX_SWIPE_COMMIT_PX = 88;

/** Hard ceiling on how far the row can be dragged, rubber-banded towards it. */
export const POSTBOX_SWIPE_MAX_PX = 132;

/** A flick commits below the distance threshold — but not from a standing start. */
export const POSTBOX_SWIPE_FLING_PX = 36;

/** Pointer speed, in px/ms, that counts as a flick rather than a drag. */
export const POSTBOX_SWIPE_FLING_VELOCITY = 0.55;

/** How long the row takes to spring back (or fly out) once released. */
export const POSTBOX_SWIPE_SETTLE_MS = 180;

/**
 * How the gesture layer reads a drag in progress.
 *
 *   - `'pending'`   — still inside the slop; nobody owns the pointer yet.
 *   - `'horizontal'`— the swipe owns it: track the finger, suppress the click.
 *   - `'abandoned'` — it is a scroll (or a press). Stand down for this pointer.
 */
export type PostboxSwipeIntent = 'pending' | 'horizontal' | 'abandoned';

/**
 * Classify a drag's first meaningful movement.
 *
 * Note the asymmetry: crossing the slop VERTICALLY abandons immediately, while
 * crossing it horizontally only claims when the movement also dominates. That
 * bias is deliberate — a mis-read scroll is a broken list, a mis-read swipe is
 * merely a swipe that did not start.
 */
export function classifySwipeIntent(
	dx: number,
	dy: number,
	slopPx: number = POSTBOX_SWIPE_SLOP_PX
): PostboxSwipeIntent {
	const ax = Math.abs(dx);
	const ay = Math.abs(dy);
	if (ay > slopPx && ay >= ax) return 'abandoned';
	if (ax <= slopPx) return 'pending';
	return ax >= ay * POSTBOX_SWIPE_DOMINANCE ? 'horizontal' : 'abandoned';
}

/** Which side of the row a displacement belongs to (`null` at exactly zero). */
export function swipeDirection(dx: number): PostboxSwipeDirection | null {
	if (dx === 0) return null;
	return dx < 0 ? 'left' : 'right';
}

/**
 * The action a displacement would fire, or `null` when that direction is set to
 * `'none'` (or there is no direction yet). The row uses this both to paint the
 * track and to decide whether to follow the finger at all.
 */
export function swipeActionFor(
	dx: number,
	leftAction: PostboxSwipeAction,
	rightAction: PostboxSwipeAction
): Exclude<PostboxSwipeAction, 'none'> | null {
	const direction = swipeDirection(dx);
	if (!direction) return null;
	const action = direction === 'left' ? leftAction : rightAction;
	return action === 'none' ? null : action;
}

/**
 * How far the row actually moves for a raw displacement: one-to-one up to the
 * commit distance, then rubber-banded so it approaches — but never reaches —
 * {@link POSTBOX_SWIPE_MAX_PX}. The resistance is the feedback that says "this
 * is as far as it goes"; a row that slid off the screen would say nothing.
 */
export function swipeTranslation(dx: number): number {
	const sign = dx < 0 ? -1 : 1;
	const distance = Math.abs(dx);
	if (distance <= POSTBOX_SWIPE_COMMIT_PX) return dx;
	const headroom = POSTBOX_SWIPE_MAX_PX - POSTBOX_SWIPE_COMMIT_PX;
	const extra = distance - POSTBOX_SWIPE_COMMIT_PX;
	return sign * (POSTBOX_SWIPE_COMMIT_PX + headroom * (1 - headroom / (headroom + extra)));
}

/** How close the drag is to committing, clamped to 0..1 (drives the track). */
export function swipeProgress(dx: number): number {
	return Math.min(1, Math.abs(dx) / POSTBOX_SWIPE_COMMIT_PX);
}

/** The reveal track behind the row, as the row needs to paint it. */
export interface PostboxSwipeTrackState {
	readonly action: Exclude<PostboxSwipeAction, 'none'>;
	readonly direction: PostboxSwipeDirection;
	readonly icon: string;
	readonly tone: PostboxSwipeTone;
	/** 0..1 towards the commit distance. */
	readonly progress: number;
	/** True once releasing here would fire the action. */
	readonly armed: boolean;
	/** Pixels the row itself is translated by (already rubber-banded). */
	readonly offsetPx: number;
}

/**
 * Everything the row needs to render one frame of a drag, or `null` when there
 * is nothing to show — no movement yet, or a direction the user mapped to
 * `'none'` (which must stay completely inert rather than revealing an empty
 * track the row then snaps back from).
 */
export function swipeTrackState(args: {
	dx: number;
	leftAction: PostboxSwipeAction;
	rightAction: PostboxSwipeAction;
}): PostboxSwipeTrackState | null {
	const direction = swipeDirection(args.dx);
	const action = swipeActionFor(args.dx, args.leftAction, args.rightAction);
	if (!direction || !action) return null;
	const visual = POSTBOX_SWIPE_VISUALS[action];
	return {
		action,
		direction,
		icon: visual.icon,
		tone: visual.tone,
		progress: swipeProgress(args.dx),
		armed: Math.abs(args.dx) >= POSTBOX_SWIPE_COMMIT_PX,
		offsetPx: swipeTranslation(args.dx),
	};
}

/**
 * The decision made on release: the action to run, or `null` to spring back.
 *
 * A flick commits short of the distance threshold, but only when it is BOTH
 * fast and still travelling the way the row moved — a finger that reverses at
 * the last moment ("no, not that") has withdrawn the gesture, and honouring its
 * speed would be the exact opposite of what it said.
 */
export function resolveSwipeRelease(args: {
	dx: number;
	/** Signed px/ms over the last few samples; positive is rightward. */
	velocityX: number;
	leftAction: PostboxSwipeAction;
	rightAction: PostboxSwipeAction;
}): Exclude<PostboxSwipeAction, 'none'> | null {
	const action = swipeActionFor(args.dx, args.leftAction, args.rightAction);
	if (!action) return null;
	const distance = Math.abs(args.dx);
	if (distance >= POSTBOX_SWIPE_COMMIT_PX) return action;
	const sameWay = args.dx < 0 ? args.velocityX < 0 : args.velocityX > 0;
	const flicked =
		sameWay &&
		distance >= POSTBOX_SWIPE_FLING_PX &&
		Math.abs(args.velocityX) >= POSTBOX_SWIPE_FLING_VELOCITY;
	return flicked ? action : null;
}

/** One position sample from the pointer stream. */
export interface PostboxSwipeSample {
	readonly x: number;
	readonly t: number;
}

/** How far back the velocity estimate looks. */
export const POSTBOX_SWIPE_VELOCITY_WINDOW_MS = 120;

/**
 * Signed horizontal velocity in px/ms over the recent samples.
 *
 * Measured over a WINDOW rather than between the last two events: pointer moves
 * arrive a few milliseconds apart, so a two-sample estimate divides a couple of
 * pixels by a couple of milliseconds and reports a flick every time the finger
 * jitters. Zero when there is nothing to measure from.
 */
export function swipeVelocity(
	samples: readonly PostboxSwipeSample[],
	windowMs: number = POSTBOX_SWIPE_VELOCITY_WINDOW_MS
): number {
	if (samples.length < 2) return 0;
	const last = samples[samples.length - 1]!;
	// Oldest sample still inside the window; falls back to the first one so a
	// very short gesture is measured over what it has rather than reported as 0.
	let first = samples[0]!;
	for (const sample of samples) {
		if (last.t - sample.t <= windowMs) {
			first = sample;
			break;
		}
	}
	const dt = last.t - first.t;
	if (dt <= 0) return 0;
	return (last.x - first.x) / dt;
}

/** Drop samples that have aged out of the velocity window. */
export function pruneSwipeSamples(
	samples: readonly PostboxSwipeSample[],
	now: number,
	windowMs: number = POSTBOX_SWIPE_VELOCITY_WINDOW_MS
): PostboxSwipeSample[] {
	return samples.filter((sample) => now - sample.t <= windowMs);
}

/**
 * How long the release animation runs. Zero under `prefers-reduced-motion`: the
 * row still follows the finger (direct manipulation is the gesture, not
 * decoration) but it never slides on its own afterwards.
 */
export function swipeSettleMs(reducedMotion: boolean): number {
	return reducedMotion ? 0 : POSTBOX_SWIPE_SETTLE_MS;
}

/**
 * True when this pointer may drive a swipe at all. Touch and pen only — a mouse
 * drag across a row on a desktop is a text selection or the start of a
 * drag-and-drop, and must never archive anything.
 */
export function isSwipePointer(pointerType: string): boolean {
	return pointerType === 'touch' || pointerType === 'pen';
}
