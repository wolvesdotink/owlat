/**
 * The interpretation eval corpus format (SPEC §9, plan §14). A corpus file is
 * JSON: `{ version: 1, slice, threads: EvalThread[] }`. Each thread holds the
 * messages as they would arrive, the internal notes a team keeps beside them
 * (which must never reach the model), and the labels a correct interpretation
 * has to produce:
 *   - `items`: the obligations the thread really carries, each with the quote
 *     that supports it, the kind of segment that quote lies in, intent,
 *     facets, who is responsible, and any deadline or amount;
 *   - `facts`: informational claims (personal mail only);
 *   - `traps`: claims a model could plausibly propose that must never become
 *     a TRACKED obligation: rejected outright (an ask from quoted history,
 *     text outside a signature), or kept only as a proposal (an ask in a
 *     forward sent as information, in a signature or a disclaimer).
 * Labelled items whose quote lies in a forwarded, signature or disclaimer
 * segment are expected to ground as proposals, never as tracked items.
 *
 * Content is fictional: neutral names, `example` domains, no real data.
 * Pure and isolate-safe; the files are read by the replay test and the
 * `apps/api/scripts/interpret-eval.ts` CLI, never by a deployed function.
 */
import { z } from 'zod';
import { ITEM_FACETS, ITEM_INTENTS, MESSAGE_SEGMENT_KINDS } from '@owlat/shared/threadBrief';

export const EVAL_SLICES = [
	'en',
	'de',
	'forwards',
	'cc_not_addressed',
	'inline_replies',
	'mailing_lists',
	'automated',
	'clearsigned_trailer',
	'long_threads',
	'out_of_order',
	'injection',
	'amounts_deadlines_tz',
	'team_notes',
] as const;

const SEGMENT_KINDS = MESSAGE_SEGMENT_KINDS;
const INTENTS = ITEM_INTENTS;
const FACETS = ITEM_FACETS;

const party = z.object({ email: z.string(), name: z.string().optional() }).strict();

const message = z
	.object({
		id: z.string(),
		direction: z.enum(['inbound', 'outbound']),
		from: party,
		to: z.array(party),
		cc: z.array(party).optional(),
		/** ISO 8601 with offset. */
		sentAt: z.string(),
		/** Arrival position when it differs from `sentAt` order (out-of-order slice). */
		arrivalOrder: z.number().int().optional(),
		subject: z.string(),
		text: z.string().optional(),
		html: z.string().optional(),
		headers: z
			.object({ listUnsubscribe: z.boolean().optional(), precedence: z.string().optional() })
			.strict()
			.optional(),
		/** The message carries a verdict of this scope (clearsigned slice). */
		signatureScope: z.enum(['clearsigned', 'mime']).optional(),
	})
	.strict();

const itemLabel = z
	.object({
		id: z.string(),
		messageId: z.string(),
		intent: z.enum(INTENTS),
		facets: z.array(z.enum(FACETS)),
		responsibility: z.enum(['us', 'them', 'unclear']),
		requester: party.optional(),
		responsible: party.optional(),
		/** Verbatim from the message (after the shared quote normalization). */
		quote: z.string(),
		segmentKind: z.enum(SEGMENT_KINDS).default('fresh'),
		assertion: z.string(),
		due: z
			.object({ phrase: z.string(), at: z.string().optional(), tz: z.string().optional() })
			.strict()
			.optional(),
		amount: z.object({ value: z.number(), currency: z.string() }).strict().optional(),
		/** `flagged`: grounds, but a derived string must trip a screen (injection slice). */
		expect: z.enum(['grounds', 'flagged']).default('grounds'),
	})
	.strict();

const factLabel = z
	.object({
		id: z.string(),
		messageId: z.string(),
		key: z
			.object({ entity: z.string(), attribute: z.string(), context: z.string().optional() })
			.strict(),
		quote: z.string(),
		segmentKind: z.enum(SEGMENT_KINDS).default('fresh'),
		assertion: z.string(),
	})
	.strict();

const trapLabel = z
	.object({
		id: z.string(),
		messageId: z.string(),
		quote: z.string(),
		/** The segment the trap claims to quote. */
		segmentKind: z.enum(SEGMENT_KINDS),
		assertion: z.string(),
		/** `proposal`: grounds, but only as a proposal (never tracked). */
		reject: z.enum(['not_fresh', 'quote_failed', 'proposal']),
	})
	.strict();

export const evalThreadSchema = z
	.object({
		id: z.string(),
		slices: z.array(z.enum(EVAL_SLICES)).min(1),
		locale: z.enum(['en', 'de']),
		mode: z.enum(['brief', 'actions']),
		us: z.array(party).min(1),
		messages: z.array(message).min(1),
		internalNotes: z
			.array(z.object({ id: z.string(), author: z.string(), text: z.string() }).strict())
			.optional(),
		/** Bulk mail from a stranger: interpretation must not run (eligibility). */
		expectIneligible: z.boolean().optional(),
		labels: z
			.object({
				items: z.array(itemLabel),
				facts: z.array(factLabel).optional(),
				traps: z.array(trapLabel).optional(),
			})
			.strict(),
	})
	.strict();

export const evalCorpusFileSchema = z
	.object({ version: z.literal(1), slice: z.enum(EVAL_SLICES), threads: z.array(evalThreadSchema) })
	.strict();

export type EvalSlice = (typeof EVAL_SLICES)[number];
export type EvalThread = z.infer<typeof evalThreadSchema>;
export type EvalMessage = EvalThread['messages'][number];
export type EvalItemLabel = EvalThread['labels']['items'][number];
export type EvalParty = z.infer<typeof party>;

/** Parse corpus files (already read as JSON) into one validated thread list. */
export function parseEvalCorpus(files: readonly unknown[]): EvalThread[] {
	const threads = files.flatMap((file) => evalCorpusFileSchema.parse(file).threads);
	const ids = new Set<string>();
	for (const thread of threads) {
		if (ids.has(thread.id)) throw new Error(`duplicate eval thread id ${thread.id}`);
		ids.add(thread.id);
		const messageIds = new Set(thread.messages.map((m) => m.id));
		const labels = [
			...thread.labels.items,
			...(thread.labels.facts ?? []),
			...(thread.labels.traps ?? []),
		];
		for (const label of labels) {
			if (!messageIds.has(label.messageId)) {
				throw new Error(`${thread.id}: label ${label.id} names unknown message ${label.messageId}`);
			}
		}
		if (thread.mode === 'actions' && (thread.labels.facts?.length ?? 0) > 0) {
			throw new Error(`${thread.id}: actions-mode threads carry no facts`);
		}
	}
	return threads;
}
