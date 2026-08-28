/**
 * Validators for the per-user Postbox preference row (`mailUserSettings`) and
 * the `mail/settings` update args that write it.
 *
 * They live beside each other, in their own module rather than in the general
 * `convexValidators.ts` grab bag, because they are ONE contract read from three
 * places — the schema field, the mutation arg and (for the sort order) the list
 * read — and a literal added on one side only is a silently rejected write.
 */

import { v } from 'convex/values';

// Postbox reader auto-advance preference (mailUserSettings.autoAdvance and
// mail/settings update args) — single source so schema and args can't drift.
export const mailAutoAdvanceValidator = v.union(
	v.literal('next'),
	v.literal('previous'),
	v.literal('back-to-list')
);

// Postbox default reply behavior (mailUserSettings.replyDefault and mail/settings
// update args) — whether the primary reply affordance / `r` opens a plain Reply
// or a Reply-all. Single source so schema and args can't drift.
export const mailReplyDefaultValidator = v.union(v.literal('reply'), v.literal('reply-all'));

// Postbox list/reader density (mailUserSettings.density and mail/settings update
// args) — 'comfortable' (the roomy default) vs 'compact' (tighter rows +
// single-line subject/snippet). Single source so schema and args can't drift.
export const mailDensityValidator = v.union(v.literal('comfortable'), v.literal('compact'));

// Postbox inbox list view mode (mailUserSettings.viewMode and mail/settings
// update args) — 'flat' (single message list, the default), 'conversations'
// (thread-grouped rows), 'categories' (People / Newsletters / Notifications /
// Receipts sections) or 'bundled' (the flat feed with runs of consecutive
// low-signal mail folded into one expandable row per category). Inbox-only;
// other folders always render flat. Single source so schema and args can't
// drift.
export const mailViewModeValidator = v.union(
	v.literal('flat'),
	v.literal('conversations'),
	v.literal('categories'),
	v.literal('bundled')
);

// Postbox reading-pane layout (mailUserSettings.readingPane and mail/settings
// update args) — where the reader sits relative to the message list. 'right'
// (the default) is the side-by-side geometry that shipped before the control
// existed; 'bottom' puts a full-width list above the reader; 'off' drops the
// reading pane entirely and makes opening a message navigate. Single source so
// schema and args can't drift.
export const mailReadingPaneValidator = v.union(
	v.literal('right'),
	v.literal('bottom'),
	v.literal('off')
);

// Postbox list-pane size (mailUserSettings.listWidth / listHeight and
// mail/settings update args) — where the divider between the list and the
// reader sits, in CSS pixels. A plain number rather than a closed set: this is
// a drag handle, so every pixel in the range is a legitimate value. The bounds
// are NOT enforced here — the client clamps on both write and read
// (utils/postboxReadingPane), so a row written by an older/newer client, or one
// whose bounds later change, still resolves to a sane layout instead of being
// rejected mid-drag. Absent ⇒ the axis default (384px wide), which is exactly
// the hardcoded geometry the layout had.
export const mailListSizeValidator = v.number();

// Postbox inbox landing mode (mailUserSettings.inboxMode and mail/settings
// update args) — 'today' (the focused single-column landing view; the default)
// vs 'browse' (the full three-pane folder UI). Inbox-only; persisted as the
// user's last-used mode. Single source so schema and args can't drift.
export const mailInboxModeValidator = v.union(v.literal('today'), v.literal('browse'));

// Postbox message-list sort order (mailUserSettings.sortOrder, mail/settings
// update args and the listMessages read) — 'newest' (arrival descending, the
// hardcoded behaviour before the control existed) vs 'oldest' (ascending, for
// clearing a backlog front to back). Date direction only: it flips `.order()`
// on the existing by_folder_and_received / by_mailbox_and_received indexes.
// Single source so schema, args and the read cannot drift.
export const mailSortOrderValidator = v.union(v.literal('newest'), v.literal('oldest'));

// Postbox undo-send window (mailUserSettings.undoSendSeconds and mail/settings
// update args) — how long a sent message is held in `pending_send` before it
// actually dispatches, i.e. how long "Undo" stays offered. A CLOSED set of four
// values rather than a free number: the composer renders it as four radio
// choices, and an arbitrary window (7 hours) is a footgun, not a preference.
// `0` is "Off" — dispatch immediately, no undo toast at all. Unset ⇒ the
// server's DEFAULT_UNDO_SEND_DELAY_MS (30s), which is exactly the behaviour
// every user had before this control existed. Single source so schema and args
// can't drift.
export const mailUndoSendSecondsValidator = v.union(
	v.literal(0),
	v.literal(10),
	v.literal(30),
	v.literal(60)
);

// Postbox mark-as-read policy (mailUserSettings.markReadPolicy and
// mail/settings update args) — WHEN an opened conversation loses its unread
// flags. 'immediate' marks on render (the behaviour every user had before this
// control existed, and the default an unset row resolves to); 'after-dwell'
// waits for a short visible dwell and cancels if the reader is navigated away
// first; 'manual' never marks automatically — the reader shows an explicit
// mark-read affordance instead. Single source so schema and args can't drift.
export const mailMarkReadPolicyValidator = v.union(
	v.literal('immediate'),
	v.literal('after-dwell'),
	v.literal('manual')
);

// Postbox quiet hours (mailUserSettings.quietHours and mail/settings update
// args) — a daily window during which desktop toasts are held back and rolled
// into one "N while you were away" summary when the window ends.
//
// `startMinute`/`endMinute` are minutes past LOCAL midnight (0..1439) on the
// user's device, not a UTC instant: "quiet from 22:00" means 22:00 wherever the
// user is, and the evaluation therefore happens client-side in the pure rules
// module. A window whose end is <= its start wraps midnight (22:00 → 07:00).
// `days` is the weekday mask the window STARTS on, 0=Sunday..6=Saturday, so a
// Friday-night window still covers Saturday's small hours.
//
// `enabled` is stored rather than inferred from the object's presence so
// turning quiet hours off keeps the window the user configured (the mutation
// patches fields, and an absent field cannot express "clear this"). Absent ⇒
// exactly today's behaviour: no window, nothing suppressed.
export const mailQuietHoursValidator = v.object({
	enabled: v.boolean(),
	startMinute: v.number(),
	endMinute: v.number(),
	days: v.array(v.number()),
});

// Postbox desktop-notification scope (mailUserSettings.notifyAbout and
// mail/settings update args). 'everything' fires a toast for every new inbox
// message; 'people-important' only for smart-category `person` mail (and any
// message whose category is absent — fail-open so nothing is silently dropped
// before the classifier has run); 'nothing' suppresses toasts entirely. Single
// source so schema and args can't drift.
export const mailNotifyAboutValidator = v.union(
	v.literal('everything'),
	v.literal('people-important'),
	v.literal('nothing')
);
