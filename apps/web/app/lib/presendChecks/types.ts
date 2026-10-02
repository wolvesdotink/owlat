/**
 * The pre-send checks' vocabulary: what a check is, what it found, and the
 * thresholds the checks hold an email to. Pure: copy travels as catalog keys
 * (`LocalizedText`) and is worded where it renders.
 */
import type { LocalizedText } from '~/utils/localizedText';

/**
 * - `pass`: nothing to fix.
 * - `warning`: worth a look; never stops the send ("Send anyway").
 * - `blocking`: the send is refused today, independent of these checks (an
 *   empty body, an unverified sending domain). No new check ever blocks.
 * - `pending`: the server half has not answered yet.
 * - `skipped`: could not run here (no MTA, screening off, the probes failed).
 */
export type PresendStatus = 'pass' | 'warning' | 'blocking' | 'pending' | 'skipped';

export type PresendCheckId =
	| 'sending'
	| 'size'
	| 'links'
	| 'linkSyntax'
	| 'imageAlt'
	| 'imageLoad'
	| 'imageWidth'
	| 'contrastLight'
	| 'contrastDark'
	| 'screening'
	| 'subject'
	| 'unsubscribe'
	| 'postalAddress';

export type PresendCategory =
	| 'sending'
	| 'size'
	| 'links'
	| 'images'
	| 'accessibility'
	| 'content'
	| 'compliance';

/** One thing a check found: a link, an image, a Block. */
export interface PresendItem {
	/** What it is: a URL, an image file or a colour pair verbatim, or a catalog key. */
	label: LocalizedText;
	/** Why it was flagged. */
	reason: LocalizedText;
	/** The Block it lives in, for "Show me"; absent when it cannot be pinned. */
	blockId?: string;
}

export interface PresendCheck {
	id: PresendCheckId;
	category: PresendCategory;
	status: PresendStatus;
	/** The one-line verdict. */
	summary: LocalizedText;
	/** Extra context under the verdict (what was not verified, why it matters). */
	note?: LocalizedText;
	items: PresendItem[];
}

/** Gmail clips the HTML of a message above this ("View entire message"). */
export { GMAIL_CLIP_BYTES } from '@owlat/shared/emailLimits';
/** Warn from here on: tracking and personalization still add to the stored HTML. */
export const GMAIL_CLIP_WARNING_BYTES = 90 * 1024;
/** An image heavier than this is slow on a phone connection. */
export const LARGE_IMAGE_BYTES = 1024 * 1024;
/** WCAG 2.x AA for body text. */
export const WCAG_AA_CONTRAST = 4.5;
/**
 * Subject heuristics the renderer's analyzer already applies
 * (`packages/email-renderer/src/analyzer.ts`): Gmail truncates around here.
 */
export const SUBJECT_MAX_CHARS = 70;
