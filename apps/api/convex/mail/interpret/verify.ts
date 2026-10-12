'use node';

/**
 * The entailment check of an interpretation (SPEC §4 `verify.ts`): a no-tool
 * call on the `guard` tier, three claims per call, asking only whether the
 * quoted words SAY the claim. It sees the claims (`pipeline.ts
 * verifyClaimsOf`) and their quotes, never the whole thread, and it cannot
 * add anything.
 *
 * Verdicts:
 *   - `supported`: the claim is applied (`verify: 'passed'`, a closing
 *     transition or a fact supersession may go through);
 *   - `unsupported`: the claim is not applied;
 *   - `unclear`, or the call failed: an item is kept as a proposal ("Check
 *     this", not tracked until confirmed); a transition or supersession is
 *     not applied. A failed call also marks the run `partial`.
 *
 * Metered as `interpret_verify` in the usage ledger. The calls draw on the
 * run's one hold (`runHold.ts`), which was admitted for the verifier's
 * schema-bounded maximum before the extraction was bought, so spend admission
 * cannot refuse them halfway (Sol r4). The prompt is bounded for that: a claim
 * is sent only when its statement fits {@link VERIFY_STATEMENT_CHARS} and it
 * has at most {@link MAX_QUOTES_PER_CLAIM} quotes within the schema's quote
 * limit; any other claim stays unverified and the verification incomplete
 * (Sol r5 F1), which keeps automation held.
 */

import { z } from 'zod';
import type { ActionCtx } from '../../_generated/server';
import { resolveLanguageModel } from '../../lib/llmProvider';
import { runLlmObject } from '../../lib/llm/dispatch';
import { meterLlmCall } from '../../analytics/meteredSpend';
import { admissionRefusalOf, type AdmissionRefusalData } from '../../lib/llm/admissionPort';
import type { AdmissionPriority } from '../../lib/validators/aiRouting';
import { rootRequest, type LlmRootContext } from '../../lib/llm/requestMeter';
import type { InterpretationSource } from '../../lib/validators/threadBrief';
import { SYSTEM_GUARD } from '../ai/promptGuards';
import { defuseDelimiters } from './prompt';
import type { VerifyClaim, VerifyVerdict } from './pipeline';
import {
	INTERPRET_TEXT_LIMITS,
	MAX_INTERPRET_FACTS,
	MAX_INTERPRET_ITEMS,
	MAX_INTERPRET_TRANSITIONS,
	MAX_QUOTES_PER_CLAIM,
} from './schema';
import type { InterpretRunHold } from './runHold';

export const VERIFY_BATCH_SIZE = 3;
export const VERIFY_FEATURE = 'interpret_verify';

/** A claim statement's length in the prompt (an item's or fact's two clamped assertions and framing). */
export const VERIFY_STATEMENT_CHARS = 2 * INTERPRET_TEXT_LIMITS.assertion + 200;

/** The most claims one run verifies: every item, transition and fact the output schema allows. */
export const MAX_VERIFY_CLAIMS =
	MAX_INTERPRET_ITEMS + MAX_INTERPRET_TRANSITIONS + MAX_INTERPRET_FACTS;

/**
 * Whether the verifier would see `claim` whole. A clipped statement or quote
 * could lose the condition or contradiction that decides it ("do not send
 * anything until I confirm"), so such a claim is never sent (Sol r5 F1).
 */
export function fitsVerifyPrompt(claim: VerifyClaim): boolean {
	return (
		claim.statement.length <= VERIFY_STATEMENT_CHARS &&
		claim.quotes.length <= MAX_QUOTES_PER_CLAIM &&
		claim.quotes.every((quote) => quote.length <= INTERPRET_TEXT_LIMITS.quote)
	);
}

/** Cut to `max` UTF-16 units, marking the cut. A bound only: no clipped claim is sent. */
function clip(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export const verdictSchema = z.object({
	verdicts: z.array(
		z.object({
			claimId: z.string(),
			verdict: z.enum(['supported', 'unsupported', 'unclear']),
		})
	),
});

/** The prompt for one batch. Pure; exported for tests. */
export function buildVerifyPrompt(claims: readonly VerifyClaim[]): string {
	const blocks = claims
		.map(
			(c) =>
				`CLAIM ${c.id}: ${defuseDelimiters(clip(c.statement, VERIFY_STATEMENT_CHARS))}\nQUOTES:\n` +
				c.quotes
					.slice(0, MAX_QUOTES_PER_CLAIM)
					.map((q) => `- "${defuseDelimiters(clip(q, INTERPRET_TEXT_LIMITS.quote))}"`)
					.join('\n')
		)
		.join('\n\n');
	return (
		`${SYSTEM_GUARD}\n\n` +
		'You check claims an assistant made about an email against the exact words it quoted. ' +
		'For each claim, answer "supported" when the quotes clearly state it (who must do what, ' +
		'the amount, the deadline, that something was done, declined or replaced), "unsupported" ' +
		'when they do not or say something else, and "unclear" when they could be read either ' +
		'way. Judge only from the quotes; know nothing else. Return one verdict per claim id.\n\n' +
		`<untrusted_email_content>\n${blocks}\n</untrusted_email_content>`
	);
}

/** Split into batches of {@link VERIFY_BATCH_SIZE}. Pure. */
export function batchClaims<T>(claims: readonly T[], size = VERIFY_BATCH_SIZE): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < claims.length; i += size) out.push(claims.slice(i, i + size));
	return out;
}

/**
 * Check every claim. Returns the verdicts that came back, whether any batch
 * failed (its claims get no verdict and stay unverified), and a spend refusal
 * if one stopped a batch: not expected under the run's hold, and then an
 * ordinary incomplete verification, whose refusal the run still reports.
 */
export async function verifyClaims(
	ctx: ActionCtx,
	claims: readonly VerifyClaim[],
	opts: {
		root?: LlmRootContext;
		/** Spend admission priority: brief mode is background work (ADR-0073, D1). */
		priority?: AdmissionPriority;
		/** The guard-tier model the run's hold was sized for. */
		model?: Awaited<ReturnType<typeof resolveLanguageModel>>;
		/** The run's hold: every batch draws on it (`runHold.ts`). */
		hold?: InterpretRunHold;
	} = {}
): Promise<{
	verdicts: Map<string, VerifyVerdict>;
	/** A batch failed or came back short: a retry may repair it. */
	isIncomplete: boolean;
	/**
	 * Some claims were too long to send whole, so they stay unverified: a retry
	 * would extract again and clip again, so the run does not retry for it.
	 */
	isUnsendable: boolean;
	/** The refusal's reason and limit, for a caller that holds on it (Sol r3 F5). */
	refusal?: AdmissionRefusalData;
}> {
	const verdicts = new Map<string, VerifyVerdict>();
	let isIncomplete = false;
	let refusal: AdmissionRefusalData | undefined;
	if (claims.length === 0) return { verdicts, isIncomplete, isUnsendable: false };
	const model = opts.model ?? (await resolveLanguageModel(ctx, 'guard'));
	// Only what the verifier can see whole is checked (Sol r5 F1): a claim whose
	// statement or quotes the prompt would clip, or one past the most the run's
	// hold covers, stays unverified, and the run is `partial` without a retry.
	const checkable = claims.filter(fitsVerifyPrompt).slice(0, MAX_VERIFY_CLAIMS);
	const isUnsendable = checkable.length < claims.length;
	for (const [index, batch] of batchClaims(checkable).entries()) {
		try {
			const { object } = await meterLlmCall(
				ctx,
				{
					feature: VERIFY_FEATURE,
					...(opts.root ? { root: opts.root } : {}),
					...(opts.priority ? { priority: opts.priority } : {}),
					...opts.hold?.verifyTarget(index),
				},
				async (meter) => {
					try {
						return await runLlmObject({
							meter,
							model,
							schema: verdictSchema,
							prompt: buildVerifyPrompt(batch),
							temperature: 0,
						});
					} finally {
						opts.hold?.count(meter.requests.length);
					}
				},
				// A lost ledger row under-counts; failing verification over it would drop claims.
				{ onWriteError: 'ignore' }
			);
			const ids = new Set(batch.map((c) => c.id));
			for (const { claimId, verdict } of object.verdicts) {
				if (ids.has(claimId) && !verdicts.has(claimId)) verdicts.set(claimId, verdict);
			}
			if (batch.some((c) => !verdicts.has(c.id))) isIncomplete = true;
		} catch (error) {
			isIncomplete = true;
			// A refusal stops the rest too: they would be refused the same way.
			refusal = admissionRefusalOf(error) ?? undefined;
			if (refusal) break;
		}
	}
	return { verdicts, isIncomplete, isUnsendable, ...(refusal ? { refusal } : {}) };
}

/**
 * The root request an interpretation's calls group under (ADR-0073): the
 * message it reads. A Team Inbox message (and a team reply) is `team:`, a
 * Postbox message, received or sent, is `postbox:`.
 */
export function interpretRoot(source: InterpretationSource): LlmRootContext {
	return rootRequest(
		source.kind === 'inbound' || source.kind === 'teamReply' ? 'team' : 'postbox',
		source.id
	);
}
