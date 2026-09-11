import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import { mailCategoryLabelValidator } from '../lib/literalValidators';
import { mailTriageVerbValidator } from '../lib/mailContentValidators';
import { editAdjustmentValidator } from '../mail/ai/editLearningValidators';

/**
 * Per-user sender knowledge: contacts, category and image overrides,
 * triage tallies and per-contact style overrides.
 *
 * Spread into `mailTables` from schema/mail.ts.
 */
export const mailContactsTables = {
	mailContacts: defineTable({
		mailboxId: v.id('mailboxes'),
		email: v.string(), // canonical lowercase
		displayName: v.optional(v.string()),
		organization: v.optional(v.string()),
		// Frecency proxy — bumped each time the user sends to this address.
		// Used to rank autocomplete suggestions.
		useCount: v.number(),
		lastUsedAt: v.number(),
		// Explicit "important sender" flag the owner toggles on a contact. Feeds
		// the Reply Queue priority score (a VIP outranks everyone). Optional so
		// existing rows read as undefined (not a VIP).
		isVip: v.optional(v.boolean()),
		// HEY-style screener: set once the owner accepts this first-time sender,
		// letting their mail into the Reply Queue / clarification loop. Optional so
		// existing rows read as undefined (unscreened, i.e. treated as accepted for
		// pre-existing correspondents that already have a row).
		isScreenerAccepted: v.optional(v.boolean()),
		createdAt: v.number(),
	})
		.index('by_mailbox_and_email', ['mailboxId', 'email'])
		.index('by_mailbox_and_lastUsed', ['mailboxId', 'lastUsedAt']),

	// Per-sender smart-inbox category overrides. When the user "Recategorizes as…"
	// a thread, the chosen category is remembered here for that sender so future
	// mail from them lands in the same section without another LLM call. A user
	// override always beats both the deterministic heuristic and the LLM.

	mailSenderCategoryOverrides: defineTable({
		mailboxId: v.id('mailboxes'),
		senderEmail: v.string(), // canonical lowercase
		label: mailCategoryLabelValidator,
		updatedAt: v.number(),
	}).index('by_mailbox_and_sender', ['mailboxId', 'senderEmail']),

	// Per-sender remote-image allowlist ("Always show images from this sender").
	// The reader blocks remote images by default; a row here means the sandboxed
	// iframe loads this sender's real images on render instead of asking again on
	// every issue of the same newsletter.
	//
	// The row is a narrow grant, not a blanket "trust". Tracking-pixel stripping
	// (packages/shared/src/postboxTrackers.ts) stays ON for allowlisted senders —
	// only the explicit per-message "Load everything" escalation lifts that, and
	// it is never persisted. Presence is the whole record; there is no "blocked"
	// state, so revoking is a delete and absent = exactly today's behaviour.

	mailSenderImageAllowlist: defineTable({
		mailboxId: v.id('mailboxes'),
		senderEmail: v.string(), // canonical lowercase
		createdAt: v.number(),
	}).index('by_mailbox_and_sender', ['mailboxId', 'senderEmail']),

	// Per-sender triage tally (idea 27) — the observation behind "you archive
	// everything from noreply@x, always archive it?".
	//
	// The rule engine is powerful and entirely manual: the system can watch
	// someone archive-on-sight from the same sender forty times and say nothing.
	// One row per (mailbox, sender, verb), incremented by the triage mutations in
	// mail/messageActions.ts. This is a COUNTER, not a log — no message ids, no
	// subjects, nothing that outlives the mail it describes.
	//
	// `count` is messages triaged; `sessions` is how many separate triage ACTIONS
	// produced them. Both gate a suggestion, so one bulk sweep over a backlog can
	// never manufacture a rule on its own — the recurrence gate the edit-learning
	// flywheel (mailVoiceProfiles.derivedAdjustments) uses, applied to triage.
	//
	// A suggestion is only ever an OFFER, exactly like autonomySuggestions:
	// `dismissedAt` records that the user declined it (and stops it coming back),
	// `actedFilterId` names the rule they accepted it into — which is also what
	// the undo deletes. Bounded per mailbox and pruned by retention, so the table
	// stays a small rolling picture of recent habits rather than a history.

	mailTriageTallies: defineTable({
		mailboxId: v.id('mailboxes'),
		senderAddress: v.string(), // canonical lowercase
		// The verbs that map onto a filter action a user would plausibly automate.
		verb: mailTriageVerbValidator,
		count: v.number(),
		sessions: v.number(),
		firstAt: v.number(),
		lastAt: v.number(),
		// The user declined this suggestion. Set once; the suggestion never
		// returns for this sender+verb (a nag is worse than no suggestion).
		dismissedAt: v.optional(v.number()),
		// The rule the user accepted this suggestion into. Present ⇒ the reader
		// shows the rule (with an undo) instead of the offer.
		actedFilterId: v.optional(v.id('mailFilters')),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		// The reader's footer read: every verb tallied for one sender.
		.index('by_mailbox_and_sender', ['mailboxId', 'senderAddress'])
		// Eviction + retention both walk least-recently-touched first.
		.index('by_mailbox_and_last', ['mailboxId', 'lastAt'])
		.index('by_last', ['lastAt']),

	// Per-mailbox signatures. Default-on-new-draft when isDefault=true.

	mailContactStyleOverrides: defineTable({
		mailboxId: v.id('mailboxes'),
		contactAddress: v.string(),
		adjustments: v.array(editAdjustmentValidator),
		createdAt: v.number(),
		updatedAt: v.number(),
	}).index('by_mailbox_and_address', ['mailboxId', 'contactAddress']),

	// Gmail-style labels (orthogonal to folders).
};
