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

import {
	defaultNotifyAbout,
	NOTIFY_ABOUT_OPTIONS,
	resolveNotifyAbout,
	type NotifyAbout,
} from '@owlat/shared/notificationRules';

/*
 * The scope vocabulary and its normalisation live in
 * `@owlat/shared/notificationRules`, because the server-sent Web Push applies
 * the same rule (apps/api/convex/push/). These are the web app's names for it.
 */
export type PostboxNotifyAbout = NotifyAbout;

/**
 * Every scope, in the order a picker offers them. VALUES ONLY — a label pinned
 * here would be English forever: the extracted surfaces resolve their labels
 * through the message catalog.
 */
export const POSTBOX_NOTIFY_ABOUT_OPTIONS: readonly PostboxNotifyAbout[] = NOTIFY_ABOUT_OPTIONS;

/**
 * Default scope. Once smart categories exist we prefer the quieter
 * 'people-important'; a deploy without the classifier (`categoriesLive` false)
 * defaults to 'everything' so a fresh install still surfaces new mail.
 */
export function defaultPostboxNotifyAbout(categoriesLive: boolean): PostboxNotifyAbout {
	return defaultNotifyAbout(categoriesLive);
}

/** Normalise a stored/unknown value to a valid scope, defaulting safely. */
export function resolvePostboxNotifyAbout(
	value: string | undefined | null,
	categoriesLive: boolean
): PostboxNotifyAbout {
	return resolveNotifyAbout(value, categoriesLive);
}
