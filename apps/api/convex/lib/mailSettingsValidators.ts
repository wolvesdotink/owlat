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
// (thread-grouped rows), or 'categories' (People / Newsletters / Notifications
// / Receipts sections). Inbox-only; other folders always render flat. Single
// source so schema and args can't drift.
export const mailViewModeValidator = v.union(
	v.literal('flat'),
	v.literal('conversations'),
	v.literal('categories')
);

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
