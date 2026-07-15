import { v, type Infer } from 'convex/values';

// Sender-impersonation heuristics computed at ingest (Sealed Mail A4), persisted
// on `mailMessages.senderHeuristics` and surfaced by the reader's sender badge as
// secondary detail lines — never a second badge, and never a claim stronger than
// what was checked. ALL fields optional; the whole object is stored absent when
// nothing fired, so an unremarkable sender / legacy row renders no extra lines
// rather than a false "all clear". Single source of truth: the schema references
// this validator and the ingest code derives its type via `Infer` below.
//
// Kept in its own module (rather than in lib/convexValidators.ts) so that file
// stays under the ~500 LOC file-size ratchet.
export const senderHeuristicsValidator = v.object({
	// From domain visually spoofs a real domain (homoglyph or punycode).
	isFromDomainSpoofed: v.optional(v.boolean()),
	// Reply-To sits on a different registrable domain than From.
	isReplyToMismatch: v.optional(v.boolean()),
	// No prior message from this address has landed in this mailbox.
	isFirstTimeSender: v.optional(v.boolean()),
	// The KNOWN contact domain this From domain is a near-miss of (present only
	// on a lookalike hit), so the reader can name it: "looks like paypal.com".
	lookalikeOfContactDomain: v.optional(v.string()),
});
export type SenderHeuristics = Infer<typeof senderHeuristicsValidator>;
