import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import { detectionSourceValidator, messageDirectionValidator } from '../lib/convexValidators';
import { editAdjustmentValidator } from '../mail/ai/editLearningValidators';

/**
 * AI features over the mailbox: learned voice profiles, extracted
 * commitments and the daily brief with its cards.
 *
 * Spread into `mailTables` from schema/mail.ts.
 */
export const mailAiTables = {
	mailVoiceProfiles: defineTable({
		mailboxId: v.id('mailboxes'),
		// User toggle: "Personalize AI drafts". When false, the profile is never
		// injected into prompts (and never recomputed) even if one exists.
		isEnabled: v.boolean(),
		// Guards against scheduling a second refresh while one is in flight.
		status: v.union(v.literal('idle'), v.literal('refreshing')),
		profile: v.optional(
			v.object({
				greetings: v.array(v.string()),
				signOffs: v.array(v.string()),
				formality: v.number(), // 1 (very casual) … 5 (very formal)
				brevity: v.number(), // 1 (terse) … 5 (elaborate)
				languages: v.array(v.string()),
				isEmojiUser: v.boolean(),
				examplePhrasings: v.array(v.string()),
			})
		),
		// Number of SENT messages sampled at the last successful derivation.
		sampleCount: v.number(),
		// Sent-folder message count observed at the last derivation — a cheap way
		// to detect "> N new sent messages since we last learned the voice".
		sentCountAtCompute: v.number(),
		lastComputedAt: v.optional(v.number()),
		// User-authored standing instructions ("never use exclamation marks",
		// "sign as Dr.") merged into every draft prompt ABOVE the derived voice.
		// These are explicit user rules, never inferred, and always applied.
		standingInstructions: v.optional(v.array(v.string())),
		// Edit-learning flywheel (mail/ai/editLearning.ts): recurring deltas the user
		// makes to the AI's OWN drafts before sending, each with a live observation
		// count. A delta only becomes a durable, injected rule once its
		// `promoted` flag flips (recurrence threshold) — one-offs never stick.
		derivedAdjustments: v.optional(v.array(editAdjustmentValidator)),
		// North-star metric: a bounded rolling window of recent normalized (0..1)
		// draft→sent edit distances. The median is derived on read.
		editDistanceSamples: v.optional(v.array(v.number())),
		createdAt: v.number(),
		updatedAt: v.number(),
	}).index('by_mailbox', ['mailboxId']),

	// Per-recipient style memory for the edit-learning flywheel. Keyed by the
	// mailbox + the LOWERCASED recipient address so an override learned from mail
	// to contact X is ONLY ever blended when drafting to that same address — it
	// can never cross a contact-scope boundary onto another recipient. Holds
	// recipient-specific deltas (e.g. "always replies to this contact in German")
	// with the same promote-on-recurrence gate as the voice-level adjustments.

	mailCommitments: defineTable({
		mailboxId: v.id('mailboxes'),
		threadId: v.id('mailThreads'),
		// The source message the commitment was extracted from (inbound message
		// that stated a deadline, or the owner's own sent message that made a
		// promise). One commitment per message+direction (dedup key).
		messageId: v.id('mailMessages'),
		// `inbound` = a deadline someone gave the owner; `outbound` = a promise the
		// owner made in sent mail.
		direction: messageDirectionValidator,
		// One line describing the commitment (<= 200 chars).
		description: v.string(),
		// The other party (who is owed / who is waiting). Display hint.
		counterparty: v.optional(v.string()),
		// Parsed absolute deadline (ms epoch), when the source stated a concrete
		// date. Absent when only a fuzzy phrase was found — the row still shows in
		// the brief but the pre-lapse reminder needs a concrete dueAt.
		dueAt: v.optional(v.number()),
		// The raw deadline phrase as written ("by Friday", "end of week"), for the
		// auditable brief even when it could not be parsed to a timestamp.
		dueHintRaw: v.optional(v.string()),
		status: v.union(
			v.literal('open'),
			v.literal('reminded'),
			v.literal('done'),
			v.literal('lapsed')
		),
		source: detectionSourceValidator,
		// Set once the pre-lapse reminder fired (status → reminded), so the cron
		// never re-reminds the same commitment.
		remindedAt: v.optional(v.number()),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index('by_mailbox', ['mailboxId'])
		// Dedup / idempotency: at most one commitment per source message+direction.
		.index('by_message', ['messageId', 'direction'])
		// Backs the pre-lapse reminder scan — open commitments per mailbox ordered
		// by deadline.
		.index('by_mailbox_status_due', ['mailboxId', 'status', 'dueAt']),

	// "What needs you today" digest snapshot (Daily Brief), rebuilt by the daily
	// cron per active mailbox (mail/dailyBrief.ts). Holds the ranked list of
	// things that need the owner (pending replies + clarification questions + due
	// follow-ups + deadlines/commitments), plus the AUDITABLE bundle of low-signal
	// mail (newsletters / receipts / notifications) it folded away — a digest that
	// silently hides something important is a trust-killer, so the exact bundled
	// threads are always inspectable. Read-only in-app surface; never sends mail
	// (an optional email delivery is a separate opt-in).

	mailDailyBriefs: defineTable({
		mailboxId: v.id('mailboxes'),
		generatedAt: v.number(),
		// Ranked "needs you" items, highest priority first (mail/ai/priorityScore.ts).
		items: v.array(
			v.object({
				kind: v.union(
					v.literal('needs_reply'),
					v.literal('clarification'),
					v.literal('followup'),
					v.literal('commitment')
				),
				threadId: v.id('mailThreads'),
				priorityScore: v.number(),
				title: v.string(),
				subtitle: v.optional(v.string()),
				// Absolute deadline (ms) when the item carries one.
				dueAt: v.optional(v.number()),
			})
		),
		// The auditable "what I bundled" view — every low-signal thread the brief
		// folded into the digest, so nothing is hidden without a trail.
		bundled: v.array(
			v.object({
				threadId: v.id('mailThreads'),
				category: v.union(v.literal('newsletter'), v.literal('notification'), v.literal('receipt')),
				fromAddress: v.string(),
				subject: v.string(),
			})
		),
		// Per-category bundled counts, for the digest header without re-counting.
		bundledCounts: v.object({
			newsletter: v.number(),
			notification: v.number(),
			receipt: v.number(),
		}),
		createdAt: v.number(),
	}).index('by_mailbox_and_generated', ['mailboxId', 'generatedAt']),

	// Daily Brief CARD cache (mail/brief.ts) — the small per-owner greeting card
	// at the top of the Today view: a <=3-sentence template summary of what
	// happened while the owner was away (new mail since local midnight, drafts
	// the agent prepared, open questions blocking the agent). One row per
	// mailbox + viewer, upserted in place; regenerated at most once per local
	// morning or when >=5 new messages arrived since the cached card
	// (stale-while-revalidate — the read query serves the cache instantly and
	// flags staleness for a background refresh). Deterministic counts only —
	// no LLM output is persisted here. Distinct from `mailDailyBriefs` (the
	// ranked "needs you" digest snapshot); this is only the greeting card.

	mailBriefCards: defineTable({
		mailboxId: v.id('mailboxes'),
		// BetterAuth user id of the viewer the card belongs to (dismissal and
		// the "your morning" framing are personal, not mailbox-global).
		userId: v.string(),
		// Viewer-local calendar day (YYYY-MM-DD) the card was generated for —
		// supplied by the client, since the server has no timezone. Only ever
		// affects the caller's own card.
		localDay: v.string(),
		generatedAt: v.number(),
		counts: v.object({
			// Inbox messages received since the viewer's local midnight.
			newMail: v.number(),
			// Reply drafts the agent prepared in the overnight window.
			drafted: v.number(),
			// Open clarification questions blocking the agent on the owner.
			questions: v.number(),
			// Low-signal mail (newsletter/notification/receipt) auto-filed in
			// the overnight window.
			autoFiled: v.number(),
		}),
		// Set to the viewer-local day the owner dismissed the card; the card is
		// hidden while this matches the viewer's current local day and comes
		// back the next morning.
		dismissedDay: v.optional(v.string()),
		createdAt: v.number(),
		updatedAt: v.number(),
	}).index('by_mailbox_and_user', ['mailboxId', 'userId']),

	// A member who lands in the fresh-start flow with no mailbox and no way to
	// connect one (no reserved hosted mailbox AND external accounts disabled)
	// can ask an admin to set one up. This is the honest dead-end escape hatch —
	// a single in-app request per member that admins resolve. Idempotent per
	// member: one open row at a time (see mail/mailboxRequest.ts).
};
