import { defineTable } from 'convex/server';
import { v } from 'convex/values';

/**
 * Ask-eagerness + clarification-memory tables — the trust dial setting, its
 * ask-outcome log, and the durable answer-memory that stops the clarify loop
 * asking twice.
 *
 * Split out of `schema/inbox.ts` so that file stays under the file-size ratchet.
 * Conceptually these sit ALONGSIDE the per-category autonomy rules: eagerness
 * decides when Owlat should stop and ask, autonomy decides when it may act, and
 * the answer-memory decides when it need not ask at all. The persistence
 * surfaces are `inbox/askEagernessSettings.ts` and `inbox/clarificationMemory.ts`;
 * the pure policy/match helpers are `inbox/askEagerness.ts` and
 * `inbox/clarificationMemoryMatch.ts`.
 */
export const askEagernessTables = {
	// Ask-eagerness setting - the single global "how readily should Owlat stop
	// and ask me a clarifying question" trust dial, stored ALONGSIDE the
	// per-category autonomy rules so the two read as one coherent control (see
	// inbox/askEagerness.ts). Single-row (single-org deployment); absent row =
	// today's behaviour (never a silent default). `mode` is validated to an
	// EagernessMode on read.
	askEagernessSettings: defineTable({
		mode: v.string(), // 'cautious' | 'balanced' | 'confident' | 'off'
		updatedAt: v.number(),
	}),

	// Clarification ask-outcome log - one row per clarifying ask, carrying the
	// cheap PREDICTED value of asking and, once the owner answers, whether the
	// answer actually CHANGED the produced draft (draft-with vs draft-without
	// divergence, sampled cheaply). Feeds calibration of the eagerness dial: are
	// the asks we predicted valuable the ones that actually moved the draft?
	// Never drives routing.
	clarificationAskLog: defineTable({
		source: v.union(v.literal('agent'), v.literal('reply_queue')),
		slotTypes: v.array(v.string()), // the slot kinds asked about
		questionCount: v.number(),
		predictedValue: v.number(), // cheap predicted value of asking, [0, 1]
		eagerness: v.optional(v.string()), // dial position at ask time, if any
		threadId: v.optional(v.id('mailThreads')),
		// Filled once the answer lands and a draft is produced:
		isDraftChanged: v.optional(v.boolean()), // answer materially changed the draft
		draftDivergence: v.optional(v.number()), // 1 - similarity, when sampled
		createdAt: v.number(),
	}).index('by_created_at', ['createdAt']),

	// Clarification answer-memory - the durable, user-editable store that stops
	// the clarify loop from asking the same question twice. Each ANSWERED
	// clarification is promoted here as a standing answer, scoped per-contact
	// (undefined contactId = org-general, promoted to fill for anyone). Before
	// asking, both clarification surfaces look up a matching standing answer and
	// fill the slot silently instead of re-asking. Inspectable + revocable from
	// settings. See inbox/clarificationMemory.ts (writes/reads) and
	// inbox/clarificationMemoryMatch.ts (the pure match rule). Contact-scope
	// isolation (lib/contactScope.ts) is enforced on read: contact A's answer
	// never fills contact B's slot unless promoted org-general.
	clarificationMemory: defineTable({
		// Contact the answer is scoped to. Undefined = org-general (promoted):
		// fills for ANY sender. Enforced on read so a contact-scoped answer never
		// leaks to a different contact.
		contactId: v.optional(v.id('contacts')),
		// The reply-slot kind (inbox/clarificationSlots.ts SLOT_TYPES). Advisory.
		slotType: v.string(),
		// Deterministic match key (slotType + normalized question) — decides
		// "is this the same question we already answered?" (never fuzzy across kinds).
		questionKey: v.string(),
		// The canonical question text, kept verbatim for the settings surface
		// ("You told Owlat: <question> -> <answer>").
		questionText: v.string(),
		// The owner's confirmed answer, replayed to fill the slot silently.
		answerValue: v.string(),
		// Which surface captured the answer.
		source: v.union(v.literal('agent'), v.literal('reply_queue')),
		// How many times the owner has (re)affirmed this answer — gates promotion.
		answerCount: v.number(),
		// How many times it has silently filled a later slot — observability.
		useCount: v.number(),
		createdAt: v.number(),
		updatedAt: v.number(),
		lastUsedAt: v.optional(v.number()),
	})
		.index('by_contact_slot', ['contactId', 'slotType'])
		.index('by_created_at', ['createdAt']),
};
