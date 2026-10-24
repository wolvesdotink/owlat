/**
 * What each control on the Reading card reads as for someone who never saved
 * it: the value `usePostboxSettings` resolves an unset settings row to. The
 * card compares against this to show its "changed from default" marker and
 * writes it back on Reset.
 *
 * The option-backed values come from each option module's own default; the
 * switches have no module of their own, so their defaults are stated here and
 * `__tests__/postboxReadingDefaults.test.ts` pins them to what
 * `usePostboxSettings` actually resolves an empty row to.
 */
import type { PostboxAutoAdvanceMode } from './postboxAutoAdvance';
import { POSTBOX_AUTO_ADVANCE_DEFAULT } from './postboxAutoAdvance';
import type { PostboxDensity } from './postboxDensity';
import { POSTBOX_DENSITY_DEFAULT } from './postboxDensity';
import type { PostboxMarkReadPolicy } from './postboxMarkReadPolicy';
import { POSTBOX_MARK_READ_POLICY_DEFAULT } from './postboxMarkReadPolicy';
import type { PostboxReadingPane } from './postboxReadingPane';
import { POSTBOX_READING_PANE_DEFAULT } from './postboxReadingPane';
import type { PostboxReplyDefaultMode } from './postboxReplyDefault';
import { POSTBOX_REPLY_DEFAULT } from './postboxReplyDefault';
import type { PostboxSwipeAction } from './postboxSwipe';
import { POSTBOX_SWIPE_LEFT_DEFAULT, POSTBOX_SWIPE_RIGHT_DEFAULT } from './postboxSwipe';

interface PostboxReadingValues {
	autoAdvance: PostboxAutoAdvanceMode;
	markReadPolicy: PostboxMarkReadPolicy;
	density: PostboxDensity;
	readingPane: PostboxReadingPane;
	swipeLeftAction: PostboxSwipeAction;
	swipeRightAction: PostboxSwipeAction;
	replyDefault: PostboxReplyDefaultMode;
	writingSuggestions: boolean;
	autoSummarize: boolean;
	readOnArrival: boolean;
	autoLoadImages: boolean;
	sendSound: boolean;
}

export const POSTBOX_READING_DEFAULTS: Readonly<PostboxReadingValues> = {
	autoAdvance: POSTBOX_AUTO_ADVANCE_DEFAULT,
	markReadPolicy: POSTBOX_MARK_READ_POLICY_DEFAULT,
	density: POSTBOX_DENSITY_DEFAULT,
	readingPane: POSTBOX_READING_PANE_DEFAULT,
	swipeLeftAction: POSTBOX_SWIPE_LEFT_DEFAULT,
	swipeRightAction: POSTBOX_SWIPE_RIGHT_DEFAULT,
	replyDefault: POSTBOX_REPLY_DEFAULT,
	writingSuggestions: true,
	autoSummarize: true,
	readOnArrival: true,
	autoLoadImages: true,
	sendSound: false,
};
