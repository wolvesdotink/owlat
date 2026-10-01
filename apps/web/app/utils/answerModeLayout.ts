/**
 * Answer mode's responsive layout, as pure rules (plan §08).
 *
 * Three layouts by width:
 *   - `split` from 1100px: conversation and composer side by side;
 *   - `stacked` from 768px: the conversation above, the composer a bottom
 *     sheet that grows with what is typed;
 *   - `phone` below 768px: two tabs, Conversation and Reply, and the reply a
 *     sheet that can be pulled up over the conversation.
 *
 * Below `split` the composer column is a sheet with three heights:
 *   - `peek`: only its handle row ("Reply to Jonas…"), the conversation gets
 *     the screen;
 *   - `half`: raised over the conversation, which stays in view above it (the
 *     "glance at the email while typing" height). On a tablet this is the
 *     resting height and grows with the draft;
 *   - `full`: the whole body. On a phone that is the Reply tab.
 *
 * The frame, the drag and the keys only ever go through these functions, so
 * the rules are pinned by unit tests without laying anything out.
 */

export type AnswerLayout = 'phone' | 'stacked' | 'split';
export type AnswerSheetState = 'peek' | 'half' | 'full';
export type AnswerTab = 'conversation' | 'reply';

/** Tailwind's `md`: below it Answer mode is the phone layout. */
export const ANSWER_STACKED_MIN_WIDTH = 768;
/** From here the conversation and the composer sit side by side. */
export const ANSWER_SPLIT_MIN_WIDTH = 1100;

export const ANSWER_PHONE_QUERY = `(max-width: ${ANSWER_STACKED_MIN_WIDTH - 0.02}px)`;
export const ANSWER_SPLIT_QUERY = `(min-width: ${ANSWER_SPLIT_MIN_WIDTH}px)`;

/**
 * The layout for two media-query answers. Split wins a tie: `useMediaQuery`
 * reports true for every query where there is no viewport to measure, and a
 * layout must never hide content then.
 */
export function answerLayoutFor(matches: { phone: boolean; split: boolean }): AnswerLayout {
	if (matches.split) return 'split';
	return matches.phone ? 'phone' : 'stacked';
}

const SHEET_ORDER: readonly AnswerSheetState[] = ['peek', 'half', 'full'];

/** One height up or down (the handle's arrow keys); the ends stay put. */
export function stepSheet(state: AnswerSheetState, direction: 'up' | 'down'): AnswerSheetState {
	const index = SHEET_ORDER.indexOf(state) + (direction === 'up' ? 1 : -1);
	return SHEET_ORDER[Math.min(SHEET_ORDER.length - 1, Math.max(0, index))]!;
}

/**
 * A tap on the handle: a resting sheet rises to where you can type while the
 * email stays in view, and a raised one gets out of the way. A full sheet
 * steps down to half rather than vanishing, so the draft stays in sight.
 */
export function toggleSheet(state: AnswerSheetState): AnswerSheetState {
	if (state === 'peek') return 'half';
	if (state === 'full') return 'half';
	return 'peek';
}

/** Where a sheet starts on arrival and after the layout changes. */
export function initialSheet(layout: AnswerLayout, tab: AnswerTab): AnswerSheetState {
	if (layout === 'phone') return tab === 'reply' ? 'full' : 'peek';
	return 'half';
}

/**
 * The tab a sheet height stands for. On a phone only the full sheet is the
 * Reply tab (a raised sheet still shows the conversation). On a tablet, where
 * there are no tabs, any visible composer counts as "reply", so a second
 * Cmd/Ctrl+J after the sheet was lowered raises it again.
 */
export function tabForSheet(state: AnswerSheetState, layout: AnswerLayout): AnswerTab {
	if (layout === 'phone') return state === 'full' ? 'reply' : 'conversation';
	return state === 'peek' ? 'conversation' : 'reply';
}

/**
 * The sheet height a tab asks for, given the current one. The two mappings
 * agree on every fixed point, so syncing them both ways never ping-pongs.
 */
export function sheetForTab(
	tab: AnswerTab,
	layout: AnswerLayout,
	current: AnswerSheetState
): AnswerSheetState {
	if (layout === 'phone') {
		if (tab === 'reply') return 'full';
		return current === 'full' ? 'peek' : current;
	}
	if (tab === 'reply') return current === 'peek' ? 'half' : current;
	return 'peek';
}

/** The raised sheet's share of the body on a phone. */
export const PHONE_HALF_FRACTION = 0.55;
/** The expanded sheet's share of the body on a tablet. */
export const STACKED_FULL_FRACTION = 0.85;
/** A tablet's resting sheet grows with the draft up to this share. */
export const STACKED_HALF_MAX_FRACTION = 0.6;
/** px/ms: a drag released faster than this is a flick to the next height. */
const FLICK_VELOCITY = 0.5;

/** The pixel height each state stands for in a body `containerHeight` tall. */
export function sheetHeights(
	layout: AnswerLayout,
	containerHeight: number,
	peekHeight: number
): Record<AnswerSheetState, number> {
	if (layout === 'phone') {
		return {
			peek: peekHeight,
			half: containerHeight * PHONE_HALF_FRACTION,
			full: containerHeight,
		};
	}
	return {
		peek: peekHeight,
		// The tablet's resting sheet sizes to its content; its cap stands in
		// for it when deciding where a drag lands.
		half: containerHeight * STACKED_HALF_MAX_FRACTION,
		full: containerHeight * STACKED_FULL_FRACTION,
	};
}

/**
 * Where a released drag lands. A flick (fast release) goes on to the next
 * height in its direction from where it was let go; a slow release settles on
 * the nearest height.
 *
 * `velocity` is px/ms with up (the sheet growing) positive.
 */
export function snapSheet(input: {
	layout: AnswerLayout;
	height: number;
	containerHeight: number;
	peekHeight: number;
	velocity: number;
}): AnswerSheetState {
	const heights = sheetHeights(input.layout, input.containerHeight, input.peekHeight);
	if (input.velocity >= FLICK_VELOCITY) {
		return SHEET_ORDER.find((state) => heights[state] > input.height) ?? 'full';
	}
	if (input.velocity <= -FLICK_VELOCITY) {
		return [...SHEET_ORDER].reverse().find((state) => heights[state] < input.height) ?? 'peek';
	}
	let nearest: AnswerSheetState = 'peek';
	for (const state of SHEET_ORDER) {
		if (Math.abs(heights[state] - input.height) < Math.abs(heights[nearest] - input.height)) {
			nearest = state;
		}
	}
	return nearest;
}

/** A drag's live height, kept between the peek row and the whole body. */
export function clampSheetHeight(height: number, containerHeight: number, peekHeight: number) {
	return Math.round(Math.min(containerHeight, Math.max(peekHeight, height)));
}

/**
 * How much of the layout viewport the on-screen keyboard covers, in px.
 *
 * iOS Safari and Chrome on Android (by default) leave the layout viewport, and
 * so `100dvh`, alone when the keyboard opens and shrink only the visual
 * viewport. A full-height page then has its bottom, where Send is, under the
 * keyboard. The covered part is what the layout viewport has below the visual
 * one. A pinch zoom shrinks the visual viewport too, which is not a keyboard,
 * so a zoomed page reports nothing.
 */
export function keyboardInset(input: {
	layoutHeight: number;
	viewportHeight: number;
	offsetTop: number;
	scale: number;
}): number {
	if (input.scale > 1.01) return 0;
	const covered = input.layoutHeight - input.viewportHeight - input.offsetTop;
	return covered > 1 ? Math.round(covered) : 0;
}
