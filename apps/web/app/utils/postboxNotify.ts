/**
 * Postbox desktop-notification scope: which new inbox mail fires a native
 * toast. The setting mirrors `mailUserSettings.notifyAbout` (single source in
 * apps/api convexValidators) and is consumed only by the desktop notification
 * composable — the badge/toast plumbing lives in
 * `~/lib/desktop/notificationRules`.
 *
 *   - `everything` — a toast for every new inbox message (the classic mail
 *     client behavior).
 *   - `people-important` — only smart-category `person` mail. Mail whose
 *     category is still absent (the classifier hasn't run) falls through as if
 *     it matched, so nothing is silently dropped before classification.
 *   - `nothing` — no toasts at all (the badge can still update, gated
 *     separately by the badge sub-setting).
 *
 * Kept as a pure utility so the reader can resolve a stored/unknown value
 * without mounting the Convex-backed settings query.
 */

export type PostboxNotifyAbout = 'everything' | 'people-important' | 'nothing';

/**
 * Smart-inbox category label (mirrors `mailMessages.category.label`). `person`
 * is the only "people & important" class; the rest are lower-signal.
 */
export type PostboxMailCategory =
	| 'person'
	| 'newsletter'
	| 'notification'
	| 'receipt'
	| 'other';

export const POSTBOX_NOTIFY_ABOUT_OPTIONS: Array<{
	value: PostboxNotifyAbout;
	label: string;
}> = [
	{ value: 'everything', label: 'Everything' },
	{ value: 'people-important', label: 'People & important only' },
	{ value: 'nothing', label: 'Nothing' },
];

/**
 * Default scope. Once smart categories exist we prefer the quieter
 * 'people-important'; a deploy without the classifier (`categoriesLive` false)
 * defaults to 'everything' so a fresh install still surfaces new mail.
 */
export function defaultPostboxNotifyAbout(categoriesLive: boolean): PostboxNotifyAbout {
	return categoriesLive ? 'people-important' : 'everything';
}

/** Normalise a stored/unknown value to a valid scope, defaulting safely. */
export function resolvePostboxNotifyAbout(
	value: string | undefined | null,
	categoriesLive: boolean,
): PostboxNotifyAbout {
	if (value === 'everything' || value === 'people-important' || value === 'nothing') {
		return value;
	}
	return defaultPostboxNotifyAbout(categoriesLive);
}
