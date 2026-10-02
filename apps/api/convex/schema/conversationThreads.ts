import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import { teamReplyAttachmentsValidator } from '../lib/validators/teamReplyAttachment';
import { conversationThreadSlaFields } from '../lib/validators/inboxSla';

/**
 * The Team Inbox conversation thread table.
 *
 * Split out of `schema/inbox.ts` when that file reached the ~500 LOC cap in
 * apps/api/convex/CONVENTIONS.md; spread back into `inboxTables` there, so
 * `schema.ts` is unchanged. The single writer is `inbox/threads/module.ts`
 * (ADR-0032).
 */
export const conversationThreadTables = {
	// Conversation Threads - groups related inbound/outbound messages into conversations
	conversationThreads: defineTable({
		subject: v.string(),
		// Normalized subject for matching (stripped of Re:/Fwd: prefixes, lowercased)
		normalizedSubject: v.string(),
		// Linked contact
		contactId: v.optional(v.id('contacts')),
		// Channel-neutral thread-list display identifier: an email for
		// email/generic channels, a raw phone/handle for SMS/WhatsApp/chat.
		// (Renamed from `contactEmail` in ADR-0032 — the misnomer the
		// channel work had already broken.)
		contactIdentifier: v.string(),
		// Thread status
		status: v.union(
			v.literal('open'), // Active conversation
			v.literal('waiting'), // Waiting for customer reply
			v.literal('resolved'), // Marked as resolved
			v.literal('closed') // Archived/closed
		),
		// Assigned team member (BetterAuth user ID)
		assignedTo: v.optional(v.string()),
		// Originating channel for the thread-list channel chip. Absent (or 'email')
		// = the default email channel and renders NO chip; a non-email value
		// ('sms' / 'whatsapp' / …) surfaces a single channel chip on the row.
		// Denormalized at create time by the thread module so the list never has to
		// join to the newest message to know the channel.
		channel: v.optional(v.string()),
		// Newest message's sealed-at-rest preview — denormalized by the thread module on
		// each inbound_activity so the team-inbox row can show a snippet line
		// without an N+1 read of the latest inboundMessages/unifiedMessages row.
		// Read-side hint only; opened by inbox queries and never gates a query.
		lastPreview: v.optional(v.string()),
		// Thread metadata
		messageCount: v.number(),
		lastMessageAt: v.number(),
		firstMessageAt: v.number(),
		// Latest draft status for quick queue filtering
		latestDraftStatus: v.optional(
			v.union(v.literal('pending'), v.literal('approved'), v.literal('rejected'), v.literal('sent'))
		),
		// Team snooze — hide the thread from the Open filter until this timestamp,
		// then the wake cron (inbox/snooze.ts → internalSweep) clears it and marks
		// it returned. Mirrors the Postbox mail snooze shape (mail/snooze.ts).
		// Absent = not snoozed. `snooze()` rejects any `until <= now`, so a real
		// value is always a future ms-epoch.
		snoozedUntil: v.optional(v.number()),
		// Set by the wake cron when a snooze lapses (or by an inbound reply that
		// clears an active snooze). Drives the transient "returned" marker on the
		// thread row so a resurfaced thread is visibly distinct from a never-snoozed
		// one. Never gates any query; purely a read-side hint.
		snoozeReturnedAt: v.optional(v.number()),
		replyAttachments: v.optional(teamReplyAttachmentsValidator), // the composer's, see validator
		// Response targets (SLA) clock + reply metrics, see lib/validators/inboxSla.ts.
		...conversationThreadSlaFields,
		createdAt: v.number(),
	})
		.index('by_status', ['status'])
		// Status (optionally after the assignee) + recency: the status tabs, with or
		// without Me / Unassigned, page in lastMessageAt order (inbox/threadFilters.ts).
		.index('by_status_and_last_message_at', ['status', 'lastMessageAt'])
		.index('by_last_message_at', ['lastMessageAt'])
		.index('by_contact', ['contactId'])
		// Me / Unassigned per status tab, in lastMessageAt order (also legacy mine).
		.index('by_assigned_to_and_status_and_last_message_at', [
			'assignedTo',
			'status',
			'lastMessageAt',
		])
		.index('by_snoozed_until', ['snoozedUntil'])
		// Response targets: the Overdue / Due soon slices and the due order range
		// over the running clock; the breach sweep reads only un-notified clocks;
		// switching targets off clears the paused ones; analytics reads a date
		// range of new conversations.
		.index('by_response_due_at', ['responseDueAt'])
		.index('by_response_paused_remaining_ms', ['responsePausedRemainingMs'])
		.index('by_breach_notified_and_response_due_at', ['slaBreachNotifiedAt', 'responseDueAt'])
		.index('by_first_message_at', ['firstMessageAt'])
		.index('by_assigned_to_and_snoozed_until', ['assignedTo', 'snoozedUntil'])
		.index('by_normalized_subject_and_contact', ['normalizedSubject', 'contactIdentifier'])
		// Team Inbox TEXT SEARCH. Two indexes rather than one denormalized
		// `searchableText` column: a thread's subject and its participant are both
		// written once at insert and never patched (inbox/threads/module.ts), so a
		// third derived column would only add a backfill and a drift risk for
		// exactly the two fields the pickers already matched client-side. The
		// search path reads both and merges them (inbox/threadFilters.ts).
		//
		// SEALED-AT-REST NOTE (Sealed Mail E8b): these index thread METADATA — the
		// subject line and the participant address — not a message body.
		// `lastPreview` IS a sealed body and is deliberately NOT indexed here.
		// See lib/atRestBodies.ts.
		.searchIndex('search_thread_subject', { searchField: 'subject' })
		.searchIndex('search_thread_participant', { searchField: 'contactIdentifier' }),
};
