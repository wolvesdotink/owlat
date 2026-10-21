/**
 * Per-surface field mappings (plan, Task migration map): for EVERY field
 * today's classifiers return, how a decision question represents it, what an
 * ambiguous or missing answer reads as, which host rule interprets it, and who
 * consumes it today. Written before any field migrates, so a migration is a
 * change to one row here plus its evaluation, never an improvised mapping at a
 * call site.
 *
 * - Enum fields become Choice domains with an explicit `unknown` outcome.
 * - Reply disposition is a Noul the host interprets (`./bundles.ts`).
 * - Language is a reviewed code domain: only codes the eval corpus covers,
 *   plus `other` and `unknown`, which keep today's sanitized classifier value.
 * - Numeric `confidence` is not asked: a self-reported confidence has no
 *   decision equivalent. Its consumers are listed with what replaces it.
 * - `importance` is an ordinal Score; the persisted number comes from a
 *   versioned host lookup checked against its one consumer, never from the
 *   Score's value or an answer probability.
 *
 * Team Inbox and Postbox categories differ and stay two mappings.
 *
 * Pure and isolate-safe. Only `category` and the reply disposition are asked in
 * this release (`./catalog.ts`); every other row is the written contract for a
 * later migration and is not asked.
 */

/** Which probability a threshold reads: never a bare "confidence". */
export type ThresholdReading = 'noul_probability' | 'choice_peakedness';

/** The answer a mapped field falls back to when the decision cannot settle it. */
export const UNKNOWN_LABEL = 'unknown';

export type FieldMapping =
	| {
			readonly executor: 'choice';
			readonly domain: readonly string[];
			/** The bundle and answer key that ask it, when a bundle does. */
			readonly askedBy?: { readonly bundleId: string; readonly key: string };
			readonly reads: 'choice_peakedness';
			readonly hostRule: string;
			readonly consumers: readonly string[];
	  }
	| {
			readonly executor: 'noul';
			readonly askedBy?: { readonly bundleId: string; readonly key: string };
			readonly reads: 'noul_probability';
			readonly hostRule: string;
			readonly consumers: readonly string[];
	  }
	| {
			readonly executor: 'score';
			/** Ordered level descriptions, lowest first. Ordinal only, never a magnitude. */
			readonly levels: readonly string[];
			readonly hostLookup: { readonly version: number; readonly values: readonly number[] };
			readonly hostRule: string;
			readonly consumers: readonly string[];
	  }
	| {
			/** Not asked: host code keeps today's source. */
			readonly executor: 'host';
			readonly hostRule: string;
			readonly consumers: readonly string[];
	  };

/** The language codes the eval corpus reviews (EN and DE threads), plus the two fallbacks. */
export const DECISION_LANGUAGE_DOMAIN = ['en', 'de', 'other', UNKNOWN_LABEL] as const;

/**
 * The importance host lookup, version 1: Score level (1-based) → persisted
 * importance. Its one consumer, `inbox/updates.ts` `updateRankScore`, adds a
 * priority weight of at most 0.3, so every gap between levels is larger than
 * that and an `urgent` update never outranks one a level more important.
 */
export const IMPORTANCE_LOOKUP = { version: 1, values: [0.1, 0.5, 0.9] } as const;

/** Team Inbox classifier (`agent/steps/classify` `classificationSchema`), field by field. */
export const TEAM_FIELD_MAPPINGS = {
	category: {
		executor: 'choice',
		domain: [
			'support',
			'sales',
			'billing',
			'feature_request',
			'complaint',
			'spam',
			'internal',
			'other',
			UNKNOWN_LABEL,
		],
		askedBy: { bundleId: 'mail.message.team', key: 'category' },
		reads: 'choice_peakedness',
		hostRule:
			'Display only (D9). `unknown` keeps the classifier label. Spam archival and the complaint auto-send block keep the classifier as their source.',
		consumers: [
			'agent/steps/classify route (spam archive)',
			'agent/steps/route/autoSendGates complaint_or_urgent',
			'inbox/updates views',
		],
	},
	priority: {
		executor: 'choice',
		domain: ['urgent', 'normal', 'low', UNKNOWN_LABEL],
		reads: 'choice_peakedness',
		hostRule: '`unknown` reads as today’s classifier priority; `urgent` keeps blocking auto-send.',
		consumers: ['agent/steps/route/autoSendGates complaint_or_urgent', 'inbox/updates rank'],
	},
	sentiment: {
		executor: 'choice',
		domain: ['positive', 'neutral', 'negative', UNKNOWN_LABEL],
		reads: 'choice_peakedness',
		hostRule: '`unknown` reads as `neutral`, the draft step’s allowlist default.',
		consumers: ['agent/steps/draft system role'],
	},
	intent: {
		executor: 'choice',
		domain: [
			'question',
			'complaint',
			'request',
			'information',
			'escalation',
			'acknowledgment',
			UNKNOWN_LABEL,
		],
		reads: 'choice_peakedness',
		hostRule:
			'`unknown` takes the reply path (it is not an informational intent) and never a trivial-intent writer.',
		consumers: ['agent/steps/classify resolveResponseDisposition', 'lib/llm/complexity'],
	},
	kind: {
		executor: 'choice',
		domain: [
			'personal',
			'update',
			'notification',
			'receipt',
			'newsletter',
			'advertising',
			UNKNOWN_LABEL,
		],
		reads: 'choice_peakedness',
		hostRule: '`unknown` is not a bulk kind, so it never makes mail informational on its own.',
		consumers: ['agent/steps/classify resolveResponseDisposition', 'inbox/updates views'],
	},
	needsResponse: {
		executor: 'noul',
		askedBy: { bundleId: 'mail.message.team', key: 'disposition' },
		reads: 'noul_probability',
		hostRule:
			'Advisory reply disposition (`./bundles.ts` `interpretDisposition`); the classifier keeps the informational exit (D9).',
		consumers: ['agent/steps/classify resolveResponseDisposition (informational exit)'],
	},
	language: {
		executor: 'choice',
		domain: DECISION_LANGUAGE_DOMAIN,
		reads: 'choice_peakedness',
		hostRule:
			'A reviewed code is used as is; `other` and `unknown` keep the sanitized classifier code.',
		consumers: ['agent/steps/draft reply language', 'calibration stamp language'],
	},
	importance: {
		executor: 'score',
		levels: [
			'Noise: nothing the recipient needs to know.',
			'Useful to know, no action.',
			'Must not be missed.',
		],
		hostLookup: IMPORTANCE_LOOKUP,
		hostRule: 'The level maps through the versioned lookup; the Score value is never stored.',
		consumers: ['inbox/updates updateRankScore'],
	},
	confidence: {
		executor: 'host',
		hostRule:
			'Not asked. The informational exit reads the disposition Noul probability instead (`./bundles.ts`); the draft confidence score, decision feedback and plan gate keep the classifier value until the writer lane’s auto-send contract replaces them.',
		consumers: [
			'agent/steps/classify INFORMATIONAL_MIN_CONFIDENCE',
			'agent/steps/draft confidenceScore',
			'inbox/decisionFeedback agentConfidence',
			'mail/interpret/planGate',
		],
	},
} as const satisfies Readonly<Record<string, FieldMapping>>;

/** Postbox classifiers: the category refinement and the Reply Queue's needs-reply verdict. */
export const POSTBOX_FIELD_MAPPINGS = {
	category: {
		executor: 'choice',
		domain: [
			'person',
			'newsletter',
			'notification',
			'receipt',
			'promotion',
			'spam',
			'other',
			UNKNOWN_LABEL,
		],
		askedBy: { bundleId: 'mail.message.postbox', key: 'category' },
		reads: 'choice_peakedness',
		hostRule:
			'Display only (D9). `unknown` keeps the persisted label. Spam movement and overrides keep `mail/category.ts` as their source.',
		consumers: ['mail/category writeCategory (Spam folder)', 'smart-inbox grouping'],
	},
	needsReply: {
		executor: 'noul',
		askedBy: { bundleId: 'mail.message.postbox', key: 'disposition' },
		reads: 'noul_probability',
		hostRule:
			'Advisory only (D9): Reply Queue inclusion and interpretation eligibility keep the needs-reply pipeline as their source.',
		consumers: ['mail/needsReply Reply Queue', 'mail/interpret eligibility'],
	},
} as const satisfies Readonly<Record<string, FieldMapping>>;
