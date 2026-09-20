import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import {
	mailAutoAdvanceValidator,
	mailDailyBriefEmailValidator,
	mailDensityValidator,
	mailInboxModeValidator,
	mailListSizeValidator,
	mailMarkReadPolicyValidator,
	mailNotifyAboutValidator,
	mailQuietHoursValidator,
	mailReadingPaneValidator,
	mailReplyDefaultValidator,
	mailShareLinkExpiryDaysValidator,
	mailShortcutOverridesValidator,
	mailShortcutPresetValidator,
	mailSortOrderValidator,
	mailSwipeActionValidator,
	mailTrashAutoPurgeDaysValidator,
	mailUndoSendSecondsValidator,
	mailViewModeValidator,
} from '../lib/mailSettingsValidators';

/**
 * Per-user Postbox preferences.
 *
 * Spread into `mailTables` from schema/mail.ts.
 */
export const mailSettingsTables = {
	mailUserSettings: defineTable({
		userId: v.string(), // BetterAuth user ID (owner)
		autoAdvance: mailAutoAdvanceValidator,
		// Inline compose autocomplete ("Writing suggestions"). Optional so existing
		// rows read as undefined; the reader defaults it ON when the `ai` flag is on.
		isWritingSuggestionsOn: v.optional(v.boolean()),
		// Auto-summarize long threads: show the cached one-line AI summary strip at the
		// top of long conversations. Optional so existing rows read as undefined; the
		// reader defaults it ON when the `ai` flag is on (user opt-out within an
		// AI-enabled deploy).
		isAutoSummarizeOn: v.optional(v.boolean()),
		// Default reply behavior: whether the primary reply affordance (Reply button
		// and the `r` shortcut) opens a plain Reply or a Reply-all. Optional so
		// existing rows read as undefined; the reader defaults it to 'reply'.
		replyDefault: v.optional(mailReplyDefaultValidator),
		// List/reader density: 'comfortable' (roomy default) vs 'compact' (tighter
		// rows + single-line subject/snippet). Optional so existing rows read as
		// undefined; the reader defaults it to 'comfortable'.
		density: v.optional(mailDensityValidator),
		// Inbox list view mode: 'flat' (single message list), 'conversations'
		// (thread-grouped), 'categories' (smart-inbox sections), 'bundled' (the
		// flat feed with consecutive low-signal runs folded into one row per
		// category) or 'sections' (the split inbox — the sections a user's
		// `pinToSection` filter rules name). Inbox-only — other folders always
		// render flat. Optional so existing rows read as undefined; the reader
		// defaults it to 'flat'.
		viewMode: v.optional(mailViewModeValidator),
		// Reading-pane layout: 'right' (the reader beside the list — the geometry
		// that shipped before this control existed), 'bottom' (a full-width list
		// above the reader) or 'off' (no reading pane; opening a message
		// navigates). Optional so existing rows read as undefined; the layout
		// defaults it to 'right'.
		readingPane: v.optional(mailReadingPaneValidator),
		// Where the divider between the list and the reader sits, in CSS pixels —
		// one field per axis, because the two layouts split along different ones
		// and a single number would carry a nonsensical size across a pane switch.
		// `listWidth` applies to the 'right' pane, `listHeight` to 'bottom'.
		// Unbounded on the wire; the client clamps on read and write, so an
		// out-of-range row resolves to a sane layout instead of a broken one.
		// Optional so existing rows read as undefined; absent ⇒ 384px / 320px,
		// exactly the hardcoded geometry.
		listWidth: v.optional(mailListSizeValidator),
		listHeight: v.optional(mailListSizeValidator),
		// Inbox landing mode: 'today' (focused single-column landing view) vs
		// 'browse' (the full three-pane folder UI). Persisted as the last-used
		// mode. Optional so existing rows read as undefined; the reader defaults
		// it to 'today'.
		inboxMode: v.optional(mailInboxModeValidator),
		// Message-list sort order: 'newest' (arrival descending) vs 'oldest'
		// (ascending, for clearing a backlog front to back). Date direction only.
		// Optional so existing rows read as undefined; the list defaults it to
		// 'newest' — exactly the hardcoded order it had before the control.
		sortOrder: v.optional(mailSortOrderValidator),
		// Play a short confirmation sound when a message is dispatched. Optional so
		// existing rows read as undefined; the reader defaults it OFF (opt-in).
		isSendSoundOn: v.optional(v.boolean()),
		// Undo-send window, in seconds: how long a sent message waits in
		// `pending_send` before it dispatches (0 = Off, dispatch immediately and
		// show no undo toast). Optional so existing rows read as undefined; the
		// composer then sends no `undoSendDelayMs` at all and the server's
		// DEFAULT_UNDO_SEND_DELAY_MS (30s) applies — exactly today's behaviour.
		undoSendSeconds: v.optional(mailUndoSendSecondsValidator),
		// When an opened conversation loses its unread flags: 'immediate' (mark on
		// render), 'after-dwell' (mark after a short visible dwell, cancelled by
		// navigating away first) or 'manual' (never automatic — the reader offers
		// an explicit mark-read button). Optional so existing rows read as
		// undefined; the reader defaults it to 'immediate', which is exactly the
		// mark-on-render behaviour it had before this control existed.
		markReadPolicy: v.optional(mailMarkReadPolicyValidator),
		// Desktop notification scope: which new inbox mail fires a native toast.
		// Optional so existing rows read as undefined; the desktop reader defaults it
		// to 'people-important' once smart categories exist and 'everything'
		// otherwise (a fresh deploy without the classifier still notifies for all).
		notifyAbout: v.optional(mailNotifyAboutValidator),
		// Sub-setting of notifyAbout: whether non-`person` mail still increments the
		// dock/taskbar unread badge (the toast can be quiet while the badge stays
		// truthful). Optional so existing rows read as undefined; the reader defaults
		// it ON (badge counts everything — the pre-existing behavior).
		isBadgeNonPeopleOn: v.optional(v.boolean()),
		// Quiet hours: a local-time window (with a weekday mask) during which
		// desktop toasts are held back and rolled into a single "N while you were
		// away" summary when the window ends. Evaluated client-side in
		// `lib/desktop/notificationRules` because the minutes are the USER's local
		// clock, not a UTC instant. Optional so existing rows read as undefined;
		// absent ⇒ no quiet window at all, exactly today's behaviour.
		quietHours: v.optional(mailQuietHoursValidator),
		// Hide message previews: a toast then carries a generic "New message" line
		// instead of the sender and subject (for shared or projected screens). The
		// notification is still actionable — only its body changes. Optional so
		// existing rows read as undefined; the reader defaults it OFF, which is
		// exactly the sender+subject preview that shipped before it existed.
		isHidePreviewOn: v.optional(v.boolean()),
		// HEY-style first-time-sender screener. When ON, mail from a sender who is
		// not a known contact / VIP / already-accepted is held OUT of the Reply
		// Queue and clarification loop until the owner accepts them. Optional so
		// existing rows read as undefined; the reader defaults it OFF (opt-in), so
		// a deploy that never toggles it keeps today's behaviour.
		isSenderScreenerOn: v.optional(v.boolean()),
		// Daily-brief email delivery (idea 29): the opt-in `mailDailyBriefs`
		// documented but never had. Absent ⇒ nothing is ever mailed, which is
		// exactly today's behaviour. `minute` is minutes past the user's LOCAL
		// midnight and `utcOffsetMinutes` carries the offset the cron needs, since
		// the sender has no request (and therefore no clock) behind it.
		dailyBriefEmail: v.optional(mailDailyBriefEmailValidator),
		// When a brief was last mailed to this user. The delivery cron compares
		// its LOCAL day against today's, which is what makes the send
		// at-most-once-per-day and idempotent across cron ticks and retries.
		lastDailyBriefEmailAt: v.optional(v.number()),
		// Trash auto-purge horizon in days (idea 67): how long a trashed message
		// survives before `mail/trashRetention.ts` deletes it for good. `0` is
		// "Never", and so is ABSENT — Owlat has never auto-emptied a trash folder,
		// so an untouched row keeps exactly today's behaviour and the sweep only
		// looks at rows that opted in.
		trashAutoPurgeDays: v.optional(mailTrashAutoPurgeDaysValidator),
		// Default lifetime, in days, of an attachment share link this user creates
		// (idea 10). Absent ⇒ the shared default of 14 days; share links did not
		// exist before this field, so there is no older behaviour to preserve.
		shareLinkExpiryDays: v.optional(mailShareLinkExpiryDaysValidator),
		// What a horizontal swipe on a thread row does, per direction (idea 21).
		// Touch and pen only. Absent ⇒ the default mapping (left archives, right
		// snoozes) rather than "off": rows had no touch verbs at all before this,
		// so there is no earlier behaviour for an untouched row to preserve. A
		// user who wants a direction inert stores 'none' there.
		swipeLeftAction: v.optional(mailSwipeActionValidator),
		swipeRightAction: v.optional(mailSwipeActionValidator),
		// When this user dismissed the one-time "your mail is sealed" nudge (idea
		// 55) — the pointer from the inbox to the Preferences card that explains
		// sealing and offers the recovery kit. A TIMESTAMP rather than a boolean so
		// the strip can be brought back deliberately later (a re-nudge after a key
		// rotation, say) by comparing against the event, instead of needing a
		// second flag. ABSENT means "not shown yet", not "already seen": the nudge
		// is new, so there is no earlier behaviour for an untouched row to
		// preserve — the same reasoning `shareLinkExpiryDays` uses — and it is
		// gated on the `sealedMail` flag, which is off by default.
		// Keyboard map this user drives the app with (idea 43b): a named preset
		// plus their own per-shortcut remaps on top. Absent ⇒ the shipped 'owlat'
		// map with no remaps, which is exactly the keyboard before the setting
		// existed. The registry that consumes both lives in the web app; the
		// backend only stores the choice.
		shortcutPreset: v.optional(mailShortcutPresetValidator),
		shortcutOverrides: v.optional(mailShortcutOverridesValidator),
		sealedMailNudgeSeenAt: v.optional(v.number()),
		createdAt: v.number(),
		updatedAt: v.number(),
	}).index('by_user', ['userId']),

	// Attachment share links (idea 10) — the file the composer took OUT of a
	// message and put behind a URL instead.
	//
	// WHY A ROW AND NOT JUST A SIGNED URL. The sealed-blob proxy already hands
	// out capability URLs, but those are minted for a caller the query site just
	// authorized and they die in an hour. A share link is the opposite: it is
	// handed to a stranger, it has to survive for weeks, and — because it does —
	// its owner must be able to see it in a list and kill it. None of that is
	// expressible in a signature; it needs a record.
	//
	// THE BYTES. `storageId` is the SAME blob the draft attachment used: the
	// composer detaches the part from the draft rather than deleting it, so
	// nothing is re-uploaded and the file never exists twice. That also means the
	// row OWNS the blob from then on — the draft no longer knows about it, so if
	// this row does not delete it, nothing will. It goes optional precisely so
	// "the bytes are gone" is representable: revocation and the expiry sweep both
	// reclaim storage immediately and clear the field, while the record survives
	// so the management list can still explain a link a recipient is asking about.
	//
	// THE SCAN GATE. A row only exists after the same ClamAV path the outbound
	// send uses returned something other than `infected`, and `scanVerdict`
	// records which outcome opened the door. Sharing must not be the hole that
	// lets a file this instance would refuse to SEND reach the internet anyway.
};
