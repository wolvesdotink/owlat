import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import { clarificationTranslationValidator } from '../inbox/clarificationValidators';
import { detectionSourceValidator, draftQualityValidator } from '../lib/convexValidators';
import { mailCategoryLabelValidator, mailCategorySourceValidator } from '../lib/literalValidators';

/**
 * Thread rollups, labels and saved searches — the list-view surface.
 *
 * Spread into `mailTables` from schema/mail.ts.
 */
export const mailThreadsTables = {
	mailThreads: defineTable({
		mailboxId: v.id('mailboxes'),
		// ANTI-LOOP MARKER (idea 29). Set on the thread of a daily brief this
		// deployment mailed to the owner's own mailbox, so the NEXT brief skips it.
		// Without it the brief is ordinary inbox mail from a known correspondent
		// and would happily become an item in tomorrow's digest — a digest of the
		// digest, compounding daily. Absent on every other thread, so the brief
		// builder's behaviour for real mail is unchanged.
		isSelfDeliveredBrief: v.optional(v.boolean()),
		normalizedSubject: v.string(),
		participants: v.array(v.string()),
		messageCount: v.number(),
		unreadCount: v.number(),
		hasFlagged: v.boolean(),
		hasAttachments: v.boolean(),
		lastMessageAt: v.number(),
		firstMessageAt: v.number(),
		latestSnippet: v.string(),
		latestFromAddress: v.string(),
		latestSubject: v.string(),
		// Newest message in the thread — the row a conversation list links to.
		latestMessageId: v.optional(v.id('mailMessages')),
		// Team-inbox collision safety. Set whenever an outbound reply is committed
		// to the thread; carries WHO (a BetterAuth user id) replied last so a
		// shared (team) inbox can show "last reply by …" and warn a second teammate
		// before they send a duplicate reply. `byUserId` is optional so pre-existing
		// rows and legacy dispatch paths that never recorded a sender still validate.
		// Undefined on threads with no outbound reply yet — the guard is inert then.
		latestReply: v.optional(
			v.object({
				messageId: v.id('mailMessages'),
				byUserId: v.optional(v.string()),
				at: v.number(),
				// Set when the reply was sent from the teammate's PERSONAL address
				// (send-as choice): the sent copy lives in their own mailbox, so the
				// team thread carries only this marker — teammates see the reply
				// happened and that it went out under a personal identity, so context
				// never silently forks. Undefined ⇒ replied as the team (classic).
				isFromPersonalAddress: v.optional(v.boolean()),
			})
		),
		folderRoles: v.array(v.string()),
		labelIds: v.array(v.id('mailLabels')),
		// Reply Queue (advisory AI): set when the latest inbound message looks like
		// it needs a reply from the mailbox owner. A deterministic heuristic flags
		// the candidate first (source `heuristic`, urgency `normal`); the cheap-tier
		// LLM refinement pass (mail/ai/needsReplyClassify.ts) upgrades it with
		// urgency / askSummary / dueHint when AI is enabled and the call succeeds.
		// Cleared by any outbound reply in the thread, archive/trash of its
		// messages, or the manual clear mutation (mail/needsReply.ts).
		needsReply: v.optional(
			v.object({
				// The inbound message that triggered the flag (usually the newest).
				messageId: v.id('mailMessages'),
				detectedAt: v.number(),
				source: detectionSourceValidator,
				urgency: v.union(v.literal('high'), v.literal('normal'), v.literal('low')),
				// Unified cross-thread priority score (mail/ai/priorityScore.ts): the
				// deterministic sender-importance signal (VIP / person / frecency)
				// blended with the LLM urgency. REPLACES the 3-bucket urgency for
				// Reply Queue ranking. Optional so pre-existing rows fall back to
				// their urgency bucket in the comparator until re-scored.
				priorityScore: v.optional(v.number()),
				// One-line "what they are asking" (<= 120 chars). LLM-refined only.
				askSummary: v.optional(v.string()),
				// ISO date when the message states a deadline. LLM-refined only.
				dueHint: v.optional(v.string()),
				// Plain-prose scheduling request detected on the trigger message (no .ics
				// attached — the calendar-invite path in PostboxInviteCard owns real
				// invites). Drives the "Scheduling request — draft a reply?" chip in the
				// reader. LLM-refined only; absent when nothing schedule-like was found.
				meetingIntent: v.optional(
					v.object({
						isScheduling: v.boolean(),
						// Verbatim time phrases the sender proposed ("Tuesday afternoon").
						proposedTimes: v.array(v.string()),
						// What the meeting is about, if stated (<= 120 chars).
						topic: v.optional(v.string()),
					})
				),
				// Clarification loop (Postbox-native): set when the refinement pass
				// decides a good reply needs a fact only the owner can supply and the
				// capable-tier divergence confirmation agrees it is genuinely open.
				// Flips the Reply Queue row from "Needs you" to "Needs your input".
				// LLM-refined only; every question is deterministically sanitized
				// (credential/OTP solicitations dropped) and attributed to the sender
				// in mail/ai/needsReplyClassify.ts before it is persisted here.
				clarification: v.optional(
					v.object({
						// True while at least one question is still awaiting an answer.
						isNeeded: v.boolean(),
						questions: v.array(
							v.object({
								// Stable id matching an incoming answer back to its question.
								id: v.string(),
								// The reply-slot kind (shared taxonomy, inbox/clarificationSlots.ts).
								slotType: v.string(),
								// The question shown to the owner.
								text: v.string(),
								// Provenance + "Owlat will never ask for your password" promise.
								attribution: v.string(),
								// Suggested scoped answers rendered as one-tap chips (multiple
								// choice); absent for a free-text-only slot.
								options: v.optional(v.array(v.string())),
								// Per-locale renderings of text + options (see
								// inbox/clarificationValidators.ts). Absent when localization
								// failed; the card then shows the canonical English copy.
								translations: v.optional(v.array(clarificationTranslationValidator)),
								// The owner's answer — absent until answered.
								answer: v.optional(
									v.object({
										value: v.string(),
										at: v.number(),
									})
								),
							})
						),
						// When the questions were surfaced (advisory ordering only).
						askedAt: v.number(),
						// Set once the owner answers — drives the draftWithAnswers path.
						answeredAt: v.optional(v.number()),
						// The starter reply produced by draftWithAnswers once the owner
						// answered. Its presence flips the card to "Draft ready".
						draft: v.optional(v.string()),
					})
				),
				// Draft-on-arrival review slot (postbox.aiDraft flag): a reply
				// pre-generated the moment the message landed — or the moment a
				// clarification was answered — via the SHARED draft service
				// (agent/shared/draftService.ts), so the owner reviews-and-sends
				// instead of starting from a blank composer. HUMAN REVIEW ONLY: its
				// presence never auto-sends. Absent when the flag is off, no AI
				// provider is configured, or generation failed (fail-soft — the
				// plain needs-reply row still renders).
				draftSlot: v.optional(
					v.object({
						// The pre-generated reply body (option 0 == this string).
						draft: v.string(),
						// Reply subject (Re: …) composed from the trigger message.
						draftSubject: v.optional(v.string()),
						// Confidence surfaced next to the draft (0..1) — the blended
						// classifier/urgency signal, NOT an auto-send authorization.
						confidence: v.number(),
						// Draft-quality self-check (completeness/grounding/tone). Absent
						// when the self-check failed → shown as "unverified" in review.
						quality: v.optional(draftQualityValidator),
						// Alternative pickable drafts (present only on low-confidence /
						// low-quality cases; options[0] == draft). Absent otherwise.
						options: v.optional(v.array(v.string())),
						// When the slot was generated (advisory; freshness display).
						generatedAt: v.number(),
					})
				),
			})
		),
		// Set when inbound ingest enqueues needs-reply classification; cleared once
		// the classify action persists a result. Backs the reconcile cron that
		// re-schedules threads whose scheduled classification was lost.
		needsReplyPendingAt: v.optional(v.number()),
		// "Remind me if no reply" follow-up watch on a sent message (Boomerang
		// parity, mail/followUps.ts). Armed at send time (from the draft's
		// followUpRemindAt) or after the fact from the reader/sent list. ANY
		// inbound delivery into the thread clears it silently; otherwise the
		// sweep cron resurfaces the thread at the deadline (sets dueAt exactly
		// once — the "No reply yet" chip + Reply Queue follow-up item key off it).
		followUp: v.optional(
			v.object({
				// The sent message being watched for a reply.
				messageId: v.id('mailMessages'),
				remindAt: v.number(),
				armedAt: v.number(),
				// Set by the sweep when the deadline passed with no reply. Its
				// presence flips the UI from "awaiting reply" to "No reply yet".
				dueAt: v.optional(v.number()),
				// Display hint for the Reply Queue ("You're waiting on <name>") —
				// the first recipient of the watched message.
				waitingOn: v.optional(v.string()),
			})
		),
		// Sweep key: mirrors followUp.remindAt while the watch is armed; cleared
		// when the watch clears OR fires (so a due watch is resurfaced exactly
		// once). Kept as a flat companion field so the cron can range-scan it
		// (same pattern as needsReplyPendingAt above).
		followUpRemindAt: v.optional(v.number()),
		// Smart-inbox category (advisory, off by default in the UI). A deterministic
		// heuristic classifies the latest inbound message first (source `heuristic`);
		// genuinely ambiguous mail is refined by the cheap-tier LLM (source `llm`,
		// mail/ai/categoryClassify.ts) behind the same aiGate as the rest of Postbox AI.
		// A user "Recategorize as…" override always wins (source `user`) and is
		// remembered per sender in mailSenderCategoryOverrides. Set at inbound ingest
		// and by the one-shot backfill; fail-soft to `other` when the LLM is
		// unavailable. Never moves or modifies mail — this is a display grouping only.
		category: v.optional(
			v.object({
				label: mailCategoryLabelValidator,
				source: mailCategorySourceValidator,
				classifiedAt: v.number(),
			})
		),
		// Cached advisory AI summary for the long-thread summary strip (mail/ai/assist.ts
		// getOrGenerateThreadSummary + mail/ai/summaryCache.ts). `messageCount` is the
		// thread's messageCount at generation time; the cache is served only while it
		// still matches the live count, so a new inbound message makes it stale and
		// the next open regenerates it (edge-triggered, never a hot loop). Absent
		// until the strip first generates one; never moves or modifies mail.
		summaryCache: v.optional(
			v.object({
				summary: v.string(),
				messageCount: v.number(),
				generatedAt: v.number(),
			})
		),
		// Muted conversation (`mail/mute.ts`). Set when the owner mutes the thread:
		// new inbound mail on it skips the inbox (the delivery pipeline routes it
		// straight to Archive), it never fires a desktop notification, and it is
		// excluded from the Reply Queue. Absent ⇒ exactly today's behaviour; the
		// mute is a property of the CONVERSATION, not of the sender, so muting one
		// noisy thread never silences the same person elsewhere.
		mutedAt: v.optional(v.number()),
		// Per-thread "notify me when they reply" (`mail/threadAlerts.ts`). Set when
		// the owner asks to be alerted about this ONE conversation: a new message
		// on it fires a desktop toast even when the notification scope is
		// people-only and even inside quiet hours. The opt-in twin of `mutedAt` —
		// absent ⇒ exactly today's behaviour, and the two are mutually exclusive
		// (arming the alert unmutes, muting disarms the alert).
		notifyOnReplyAt: v.optional(v.number()),
		// Transient "came back from snooze" marker (ported from the Team Inbox's
		// `inboxThreads.snoozeReturnedAt`). Stamped by the snooze wake sweep, shown
		// as a quiet chip on the list row and in the reader header, and cleared the
		// first time the thread is opened — so a resurfaced conversation is
		// recognisable as "you asked for this back" rather than looking like new
		// mail. Advisory display state only: nothing routes off it.
		snoozeReturnedAt: v.optional(v.number()),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index('by_mailbox_and_last_message', ['mailboxId', 'lastMessageAt'])
		.index('by_mailbox_and_subject', ['mailboxId', 'normalizedSubject'])
		// Backs the needs-reply reconcile cron — range scan on needsReplyPendingAt.
		.index('by_needs_reply_pending', ['needsReplyPendingAt'])
		// Backs the Reply Queue list — flagged threads per mailbox without a
		// full-table scan (undefined needsReply sorts before every number, so the
		// query lower-bounds detectedAt with gt(0), like the pending sweep above).
		.index('by_mailbox_needs_reply', ['mailboxId', 'needsReply.detectedAt'])
		// Backs the 1-minute follow-up sweep cron — range scan on
		// followUpRemindAt <= now (lower-bounded gt(0) like the snooze sweep).
		.index('by_follow_up_remind', ['followUpRemindAt'])
		// Backs the Reply Queue's "You're waiting on <name>" follow-up items —
		// due watches per mailbox without a full-table scan.
		.index('by_mailbox_follow_up_due', ['mailboxId', 'followUp.dueAt']),

	// Per-identity (mailbox) writing-voice profile, derived from the user's own
	// SENT mail so advisory AI drafts sound like them. Recomputed lazily (see
	// mail/ai/voiceProfile.ts): a stale row is served as-is while a background
	// refresh is scheduled. `profile` is undefined until the first successful
	// derivation — absence means "exactly today's non-personalized behaviour".

	mailLabels: defineTable({
		mailboxId: v.id('mailboxes'),
		name: v.string(),
		color: v.optional(v.string()),
		// Nesting (idea 38), mirroring `mailFolders.parentId`. A label's `name` is
		// its LEAF segment only — `Work/Clients/Acme` is three rows, each pointing
		// at its parent — so renaming a branch never has to rewrite descendants.
		// Absent = a root label, which is exactly what every pre-nesting row is.
		parentId: v.optional(v.id('mailLabels')),
		// Manual sibling order, ascending; ties break on name so a fresh mailbox
		// (every row at the default 0) still renders alphabetically as before.
		order: v.optional(v.number()),
		// Pinned labels sort above their unpinned siblings at the same depth.
		isPinned: v.optional(v.boolean()),
		createdAt: v.number(),
	})
		.index('by_mailbox', ['mailboxId'])
		.index('by_mailbox_and_name', ['mailboxId', 'name'])
		// Sibling lookup for the tree build, the create-time dedup within one
		// parent, and the reparent cycle guard.
		.index('by_mailbox_and_parent', ['mailboxId', 'parentId']),

	// Attachment index — one row per (message, attachment part).
	//
	// `mailMessages.attachments` is an ARRAY, which Convex cannot index: a
	// `filename:` search could only ever be a post-filter over a page of
	// arrival-ordered rows, and there was no way to browse attachments at all.
	// This junction table is the indexable mirror of that array, exactly as
	// `semanticFileContacts` mirrors `semanticFiles.contactIds`
	// (schema/knowledge.ts).
	//
	// Written by `mail/attachmentIndex.ts` from every path that inserts a
	// `mailMessages` row (inbound delivery, sent mail, IMAP APPEND, IMAP COPY)
	// and torn down by the same module when a message row is deleted. Existing
	// mail is picked up by the resumable backfill (`mail/attachmentBackfill.ts`),
	// so the Files view is complete rather than "everything since the deploy".
	//
	// The row DENORMALIZES `fromAddress` / `receivedAt` / `folderId` off the
	// parent message so the Files view can facet and sort without loading every
	// message; those three are immutable in practice except for `folderId`,
	// which the index deliberately does not chase (a moved message's file still
	// lists — the Files view is a mailbox-wide index, not a folder view).

	mailSavedSearches: defineTable({
		mailboxId: v.id('mailboxes'),
		name: v.string(),
		rawQuery: v.string(),
		// Pinned entries render in the folder rail; the rest live on the search
		// page. Kept explicit rather than derived so unpinning is not a delete.
		isPinned: v.boolean(),
		// Manual rail order, ascending. Assigned at insert (append to the end);
		// ties break on creation time so a duplicated order can't reshuffle.
		order: v.number(),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index('by_mailbox', ['mailboxId'])
		.index('by_mailbox_and_name', ['mailboxId', 'name']),

	// Compose drafts. Live separately from mailMessages so autosaves don't
	// pollute the Drafts folder IMAP view. On Send, the draft is finalized
	// into mailMessages (Sent folder) and the draft row is deleted.
};
