/**
 * The interpretation call contract (SPEC §4): what `interpretMessage` hands the
 * model and what the model must return. Isolate-safe (no `'use node'`, no
 * Convex context), shared by the Postbox and the Team Inbox.
 *
 * The OUTPUT is a strict union on `mode`:
 * - `brief` (personal Postbox mailboxes) adds `latest` and `facts`;
 * - `actions` (every team surface) has neither, and a payload that carries
 *   either fails to parse.
 *
 * Every array is bounded. The model never sees an internal id it could
 * invent: items, facts and participants carry the ids the prompt gave it, and
 * every claim cites quotes `{segmentId, text}` that grounding (`ground.ts`)
 * resolves to offsets and rejects unless verbatim.
 *
 * Two schema families:
 * - MODEL schemas ({@link interpretOutputSchemaFor}, `briefModelSchema`,
 *   `actionsModelSchema`): what the provider receives. A plain object per mode
 *   (providers reject a root union), every key required at every level,
 *   optional values `.nullable()`, never `.optional()` (strict structured
 *   output rejects a property missing from `required`).
 * - PARSE schemas ({@link interpretOutputSchema}, `briefOutputSchema`,
 *   `actionsOutputSchema`): validate a model result or a stored payload, and
 *   tolerate keys added later (an item without `consequences`).
 */

import { z } from 'zod';
import {
	ITEM_CONSEQUENCE_KINDS,
	ITEM_DISPOSITIONS,
	ITEM_FACETS,
	ITEM_INTENTS,
	ITEM_STATUSES,
	INTERPRET_MODES,
	MESSAGE_SEGMENT_KINDS,
	type InterpretMode,
} from '@owlat/shared/threadBrief';
import { APP_LOCALES, type AppLocale } from '@owlat/shared/appLocales';
import { REPLY_INTENTS } from '../ai/replyIntent';

// ── Versions and bounds ────────────────────────────────────────────────────

/** Bump when the prompt or the contract changes what is extracted: stored rows are re-run. */
export const INTERPRET_EXTRACTOR_VERSION = 4;
/** Shape version of the sealed `messageInterpretations.payload` JSON. */
export const INTERPRET_PAYLOAD_VERSION = 1;

export const MAX_INTERPRET_ITEMS = 10;
export const MAX_INTERPRET_TRANSITIONS = 10;
export const MAX_INTERPRET_FACTS = 12;
/** "Latest update" lines per locale. */
export const MAX_LATEST_LINES = 2;
export const MAX_QUOTES_PER_CLAIM = 3;
export const MAX_ITEM_OPTIONS = 5;
/** Open items (plus items closed within {@link CLOSED_ITEM_LOOKBACK_MS}) per prompt page. */
export const MAX_PROMPT_ITEMS = 40;
export const MAX_PROMPT_FACTS = 30;
export const CLOSED_ITEM_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

/** Clamp lengths, applied by the sanitizer after parsing (a long string must not fail the parse). */
export const INTERPRET_TEXT_LIMITS = {
	assertion: 300,
	display: 200,
	latestLine: 280,
	quote: 400,
	option: 120,
	duePhrase: 120,
	participantName: 120,
	factKeyPart: 80,
	factValueText: 300,
} as const;

// ── Shared pieces ──────────────────────────────────────────────────────────

/** A verbatim quote from one segment of the message. */
export const quoteSchema = z.object({
	segmentId: z.string().describe('Id of the segment the quote comes from, like "s2"'),
	text: z.string().describe('The exact words from that segment, copied verbatim'),
});

const quotesSchema = z.array(quoteSchema).max(MAX_QUOTES_PER_CLAIM);

/** An object shape with one `schema` per interface locale (`APP_LOCALES`). */
function perLocaleShape<T extends z.ZodTypeAny>(schema: T): Record<AppLocale, T> {
	return Object.fromEntries(APP_LOCALES.map((locale) => [locale, schema])) as Record<AppLocale, T>;
}

/** One display string per interface locale. German uses lowercase informal "du". */
export const displaySchema = z.object(perLocaleShape(z.string()));

/**
 * A party to an item or fact. `ref` is a participant id from the prompt
 * (`p1`…); name/email are for someone the prompt did not list (a forwarded
 * author). All null = unclear.
 */
export const participantProposalSchema = z.object({
	ref: z.string().nullable(),
	name: z.string().nullable(),
	email: z.string().nullable(),
});

export const dueProposalSchema = z.object({
	phrase: z.string().describe('The deadline as written'),
	at: z.string().nullable().describe('ISO 8601 date or date-time when it resolves to one'),
	tz: z.string().nullable(),
	ambiguous: z.boolean(),
	condition: z.string().nullable(),
});

export const amountProposalSchema = z.object({
	value: z.number(),
	currency: z.string().describe('ISO 4217 code'),
});

/** What makes an item consequential; `[]` when nothing does (isConsequential). */
const consequencesSchema = z
	.array(z.enum(ITEM_CONSEQUENCE_KINDS))
	.max(ITEM_CONSEQUENCE_KINDS.length)
	.describe(
		'Every way acting on this item commits the reader: payment, signature, access, disclosure, promise, concession, cancellation. Empty when none, null when unsure.'
	);

/**
 * An item proposal with the given `consequences` schema: required and
 * nullable for the model ({@link itemModelSchema}), also absent-tolerant for
 * parsing stored payloads ({@link itemProposalSchema}). Null or absent counts
 * as consequential.
 */
function itemShape<C extends z.ZodTypeAny>(consequences: C) {
	return {
		matchItemId: z.string().nullable().describe('Id of an open item this repeats, or null'),
		intent: z.enum(ITEM_INTENTS),
		facets: z.array(z.enum(ITEM_FACETS)),
		consequences,
		assertion: z.string().describe('The obligation in the language of the email'),
		display: displaySchema,
		requester: participantProposalSchema,
		responsible: participantProposalSchema,
		beneficiary: participantProposalSchema.nullable(),
		due: dueProposalSchema.nullable(),
		amount: amountProposalSchema.nullable(),
		options: z.array(z.string()).max(MAX_ITEM_OPTIONS).nullable(),
		quotes: quotesSchema,
	};
}

/** The item the MODEL returns: every key present (structured-output strict mode). */
export const itemModelSchema = z.object(itemShape(consequencesSchema.nullable()));

/** An item as PARSED from a stored payload: `consequences` may be absent (pre-tag payloads). */
export const itemProposalSchema = z.object(itemShape(consequencesSchema.nullable().optional()));

function transitionShape<A extends z.ZodTypeAny>(about: A) {
	return {
		itemId: z
			.string()
			.nullable()
			.describe('Id of the OPEN ITEM this changes; null when the obligation is not listed'),
		// An obligation not seen yet ("I've paid invoice 2041" before the
		// request arrived): kept and matched when the request creates its item.
		about,
		to: z.enum(ITEM_STATUSES).nullable(),
		disposition: z.enum(ITEM_DISPOSITIONS).nullable(),
		quotes: quotesSchema,
	};
}

const aboutSchema = z
	.string()
	.nullable()
	.describe('When itemId is null: the obligation this message reports on, in one sentence');

/** A transition as the MODEL returns it (every key required). */
export const transitionModelSchema = z.object(transitionShape(aboutSchema));
/** A transition as PARSED (`about` may be absent from a payload written before it existed). */
export const transitionProposalSchema = z.object(transitionShape(aboutSchema.optional()));

export const meetingIntentSchema = z.object({
	isScheduling: z.boolean(),
	proposedTimes: z.array(z.string()),
	topic: z.string().nullable(),
});

export const coverageProposalSchema = z.object({
	segmentsRead: z.array(z.string()),
	uncertain: z.boolean(),
	overflow: z.boolean(),
});

function actionsPart<I extends z.ZodTypeAny, T extends z.ZodTypeAny>(item: I, transition: T) {
	return {
		items: z.array(item).max(MAX_INTERPRET_ITEMS),
		transitions: z.array(transition).max(MAX_INTERPRET_TRANSITIONS),
		// Postbox projection: the server still runs decideNeedsReply on it.
		replyIntent: z.enum(REPLY_INTENTS),
		urgency: z.enum(['high', 'normal', 'low']),
		meetingIntent: meetingIntentSchema.nullable(),
		coverage: coverageProposalSchema,
	};
}

const latestLineSchema = z.object({ text: z.string(), quotes: quotesSchema });

export const factKeyProposalSchema = z.object({
	entity: z.string(),
	attribute: z.string(),
	context: z.string().nullable(),
});

export const factValueProposalSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('date'), at: z.string().describe('ISO 8601 date or date-time') }),
	z.object({ kind: z.literal('money'), value: z.number(), currency: z.string() }),
	z.object({ kind: z.literal('ref'), text: z.string() }),
	z.object({ kind: z.literal('url'), text: z.string() }),
	z.object({ kind: z.literal('text'), text: z.string() }),
]);

export const factProposalSchema = z.object({
	matchFactId: z.string().nullable(),
	key: factKeyProposalSchema,
	assertion: z.string(),
	value: factValueProposalSchema.nullable(),
	display: displaySchema,
	quotes: quotesSchema,
	supersedes: z.string().nullable().describe('Id of the current fact this replaces'),
	conflictsWith: z.string().nullable().describe('Id of a current fact this contradicts'),
	reportedBy: participantProposalSchema,
});

/** Why a message's exact wording matters more than any summary of it. */
export const EXACT_WORDING_REASONS = ['legal', 'terms', 'payment_details', 'security'] as const;

/**
 * Brief mode: whether the reader should keep this message's original open
 * next to the brief ("Read the exact wording"), and why. A display hint only:
 * it can show more of the original, never less, so it is not grounded.
 */
export const exactWordingSchema = z.object({
	isRequired: z.boolean(),
	reason: z.enum(EXACT_WORDING_REASONS).nullable(),
});

// ── Output ─────────────────────────────────────────────────────────────────

const latestSchema = z.object(perLocaleShape(z.array(latestLineSchema).max(MAX_LATEST_LINES)));
const factsSchema = z.array(factProposalSchema).max(MAX_INTERPRET_FACTS);

/**
 * MODEL schemas: what {@link interpretOutputSchemaFor} hands to `runLlmObject`.
 * Every key at every level is required (optional values are `.nullable()`),
 * because the OpenAI adapter sends `strict: true` and strict structured output
 * rejects a property missing from `required`. Never add `.optional()` here; the
 * JSON-schema test in `__tests__/schema.test.ts` enforces it.
 */
export const briefModelSchema = z.strictObject({
	mode: z.literal('brief'),
	...actionsPart(itemModelSchema, transitionModelSchema),
	latest: latestSchema,
	facts: factsSchema,
	exactWording: exactWordingSchema,
});

export const actionsModelSchema = z.strictObject({
	mode: z.literal('actions'),
	...actionsPart(itemModelSchema, transitionModelSchema),
});

/**
 * PARSE schemas: validate a model result or a stored payload. Same contract,
 * but tolerant of payloads written before an optional tag existed (an item
 * without `consequences`). A model result always parses here.
 */
/** Personal Postbox: actions plus "Latest update" and facts. */
export const briefOutputSchema = z.strictObject({
	mode: z.literal('brief'),
	...actionsPart(itemProposalSchema, transitionProposalSchema),
	latest: latestSchema,
	facts: factsSchema,
	// Absent on payloads stored before extractor version 2.
	exactWording: exactWordingSchema.optional(),
});

/** Every team surface: actions only. `latest` / `facts` are rejected. */
export const actionsOutputSchema = z.strictObject({
	mode: z.literal('actions'),
	...actionsPart(itemProposalSchema, transitionProposalSchema),
});

export const interpretOutputSchema = z.discriminatedUnion('mode', [
	briefOutputSchema,
	actionsOutputSchema,
]);

/** The MODEL schema for `mode`: a plain object (providers reject a root union), all keys required. */
export function interpretOutputSchemaFor(
	mode: InterpretMode
): typeof briefModelSchema | typeof actionsModelSchema {
	return mode === 'brief' ? briefModelSchema : actionsModelSchema;
}

export type InterpretOutput = z.infer<typeof interpretOutputSchema>;
export type InterpretBriefOutput = z.infer<typeof briefOutputSchema>;
export type InterpretActionsOutput = z.infer<typeof actionsOutputSchema>;
export type InterpretItemProposal = z.infer<typeof itemProposalSchema>;
export type InterpretModelOutput =
	| z.infer<typeof briefModelSchema>
	| z.infer<typeof actionsModelSchema>;
export type InterpretTransitionProposal = z.infer<typeof transitionProposalSchema>;
export type InterpretFactProposal = z.infer<typeof factProposalSchema>;
export type InterpretQuote = z.infer<typeof quoteSchema>;
export type InterpretParticipantProposal = z.infer<typeof participantProposalSchema>;
export type InterpretLatestLine = z.infer<typeof latestLineSchema>;

// ── Input ──────────────────────────────────────────────────────────────────

export const PARTICIPANT_ROLES = ['from', 'to', 'cc', 'us'] as const;

export const inputSegmentSchema = z.object({
	id: z.string(),
	kind: z.enum(MESSAGE_SEGMENT_KINDS),
	author: z.object({ name: z.string().optional(), email: z.string().optional() }).optional(),
	sentAt: z.number().optional(),
	text: z.string(),
});

export const inputParticipantSchema = z.object({
	ref: z.string(),
	role: z.enum(PARTICIPANT_ROLES),
	name: z.string().optional(),
	email: z.string().optional(),
	isUs: z.boolean(),
});

export const inputItemSchema = z.object({
	id: z.string(),
	revision: z.number(),
	intent: z.enum(ITEM_INTENTS),
	facets: z.array(z.enum(ITEM_FACETS)),
	status: z.enum(ITEM_STATUSES),
	responsible: z.string().describe('Participant ref, a name, or "unclear"'),
	assertion: z.string(),
	evidenceExcerpt: z.string(),
});

export const inputFactSchema = z.object({
	id: z.string(),
	key: z.string(),
	assertion: z.string(),
	evidenceExcerpt: z.string(),
});

/**
 * What `prompt.ts` renders. The message sits inside `<untrusted_email_content>`
 * after SYSTEM_GUARD. `itemsOverflow` / `factsOverflow` say a page did not hold
 * everything: the interpretation is then incomplete, never silently capped.
 */
export const interpretInputSchema = z.object({
	mode: z.enum(INTERPRET_MODES),
	message: z.object({
		segments: z.array(inputSegmentSchema),
		sentAt: z.number(),
		timezone: z.string(),
		sourceRevision: z.string(),
	}),
	participants: z.array(inputParticipantSchema),
	openItems: z.array(inputItemSchema).max(MAX_PROMPT_ITEMS),
	itemsOverflow: z.boolean(),
	// Brief mode only; empty in actions mode.
	currentFacts: z.array(inputFactSchema).max(MAX_PROMPT_FACTS),
	factsOverflow: z.boolean(),
	locales: z.array(z.enum(APP_LOCALES)),
});

export type InterpretInput = z.infer<typeof interpretInputSchema>;
export type InterpretInputSegment = z.infer<typeof inputSegmentSchema>;
export type InterpretInputParticipant = z.infer<typeof inputParticipantSchema>;
export type InterpretInputItem = z.infer<typeof inputItemSchema>;
export type InterpretInputFact = z.infer<typeof inputFactSchema>;
