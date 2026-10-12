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
 * Metered as `interpret_verify` in the usage ledger.
 */

import { z } from 'zod';
import type { ActionCtx } from '../../_generated/server';
import { resolveLanguageModel } from '../../lib/llmProvider';
import { runLlmObject } from '../../lib/llm/dispatch';
import { meterLlmCall } from '../../analytics/meteredSpend';
import type { AdmissionPriority } from '../../lib/validators/aiRouting';
import { rootRequest, type LlmRootContext } from '../../lib/llm/requestMeter';
import type { InterpretationSource } from '../../lib/validators/threadBrief';
import { SYSTEM_GUARD } from '../ai/promptGuards';
import { defuseDelimiters } from './prompt';
import type { VerifyClaim, VerifyVerdict } from './pipeline';

export const VERIFY_BATCH_SIZE = 3;
export const VERIFY_FEATURE = 'interpret_verify';

const verdictSchema = z.object({
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
				`CLAIM ${c.id}: ${defuseDelimiters(c.statement)}\nQUOTES:\n` +
				c.quotes.map((q) => `- "${defuseDelimiters(q)}"`).join('\n')
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
 * Check every claim. Returns the verdicts that came back and whether any
 * batch failed (its claims get no verdict and stay unverified).
 */
export async function verifyClaims(
	ctx: ActionCtx,
	claims: readonly VerifyClaim[],
	root?: LlmRootContext,
	/** Spend admission priority: brief mode is background work (ADR-0073, D1). */
	priority?: AdmissionPriority
): Promise<{ verdicts: Map<string, VerifyVerdict>; isIncomplete: boolean }> {
	const verdicts = new Map<string, VerifyVerdict>();
	let isIncomplete = false;
	if (claims.length === 0) return { verdicts, isIncomplete };
	const model = await resolveLanguageModel(ctx, 'guard');
	for (const batch of batchClaims(claims)) {
		try {
			const { object } = await meterLlmCall(
				ctx,
				{ feature: VERIFY_FEATURE, ...(root ? { root } : {}), ...(priority ? { priority } : {}) },
				(meter) =>
					runLlmObject({
						meter,
						model,
						schema: verdictSchema,
						prompt: buildVerifyPrompt(batch),
						temperature: 0,
					}),
				// A lost ledger row under-counts; failing verification over it would drop claims.
				{ onWriteError: 'ignore' }
			);
			const ids = new Set(batch.map((c) => c.id));
			for (const { claimId, verdict } of object.verdicts) {
				if (ids.has(claimId) && !verdicts.has(claimId)) verdicts.set(claimId, verdict);
			}
			if (batch.some((c) => !verdicts.has(c.id))) isIncomplete = true;
		} catch {
			isIncomplete = true;
		}
	}
	return { verdicts, isIncomplete };
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
