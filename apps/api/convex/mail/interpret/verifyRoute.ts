'use node';

/**
 * Which claims an interpretation verifies, and how (ADR-0073, plan Phase 3),
 * by two routing-policy settings, both off by default:
 *
 * - `verifyClaimCapPerMessage` (default `null`, no cap): at most this many
 *   claims are checked, in order. A claim over the cap gets no verdict, so it
 *   is never applied: an item stays a proposal, a closing transition or a
 *   fact supersession is not applied. The run is then `partial`
 *   (`verify_capped`), which holds auto-send for a person and is not retried.
 * - `claimVerification`:
 *   - `off`: the language verifier (`./verify.ts`), as today.
 *   - `enforce`: on the decision rung (`ai.decisionPlane` on, a usable
 *     non-language provider), ONE decision question per claim and its quotes
 *     replaces the verifier, through the decisions lane's runner and claim.
 *     On the language rung the verifier IS the rung and runs as today. A
 *     provider that cannot answer is terminal (D3): no claim is verified and
 *     the run is `partial` (`verify_unavailable`), with no language call in
 *     its place.
 *   - `shadow`: the verifier decides; on the decision rung each checked claim
 *     is also asked as a shadow observation with the verifier's verdict as its
 *     baseline. It never changes a verdict.
 *
 * Every claim check records under `mail.claim_check`, one logical call per
 * claim, so the ledger counts checked claims and their cost.
 */

import type { LanguageModel } from 'ai';
import type { ActionCtx } from '../../_generated/server';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import type { LlmRootContext } from '../../lib/llm/requestMeter';
import type { InterpretationSource } from '../../lib/validators/threadBrief';
import { CLAIM_CHECK_BUNDLE } from '../../lib/decision/bundles';
import { planClaimCheck, type BundlePlan } from '../../lib/decision/routing';
import {
	resolveBundleRung,
	runBundle,
	type BundleSubject,
	type ResolvedRung,
} from '../../decision/bundleRunner';
import type { RoutingContext } from '../../decision/context';
import { verifyClaims } from './verify';
import { admissionRefusalOf, type AdmissionRefusalData } from '../../lib/llm/admissionPort';
import type { AdmissionPriority } from '../../lib/validators/aiRouting';
import type { InterpretRunHold } from './runHold';
import { claimCheckState, labelOfVerdict, verdictOfLabel } from './claimCheck';
import type { VerifyClaim, VerifyVerdict } from './pipeline';

export interface RoutedVerification {
	readonly verdicts: Map<string, VerifyVerdict>;
	/** A check failed or came back short: a retry may repair it (`verify`). */
	readonly isIncomplete: boolean;
	/** Some claims were too long to ask about whole: unverified, never retried. */
	readonly isUnsendable: boolean;
	/** Claims past the per-message cap were not checked (`verify_capped`). */
	readonly isCapped: boolean;
	/** Claim checks are enforced and the decision provider cannot answer (D3). */
	readonly isUnavailable: boolean;
	/** A spend refusal stopped a check: the run reports it (D1), never as a model failure. */
	readonly refusal?: AdmissionRefusalData;
}

/** The message a claim check is about, when the decision plane can judge it. */
function subjectOf(
	source: InterpretationSource,
	mailboxId: Id<'mailboxes'> | undefined
): BundleSubject | undefined {
	if (source.kind === 'inbound') return { kind: 'inbound_message', inboundMessageId: source.id };
	if ((source.kind === 'mail' || source.kind === 'outboundMail') && mailboxId) {
		return { kind: 'mail_message', mailMessageId: source.id, mailboxId };
	}
	return undefined; // a Team reply: no artifact subject, the verifier as today
}

/** The routing policy and plane snapshot, or null (the defaults) when it cannot be read. */
async function readRouting(ctx: ActionCtx): Promise<RoutingContext | null> {
	try {
		return await ctx.runQuery(internal.decision.context.routingContext, {});
	} catch {
		return null;
	}
}

/** Verify an interpretation's claims under the routing policy. */
export async function verifyRouted(
	ctx: ActionCtx,
	claims: readonly VerifyClaim[],
	opts: {
		source: InterpretationSource;
		mailboxId?: Id<'mailboxes'>;
		/** The run's root request: every call of the run groups under it. */
		root: LlmRootContext;
		/** The language verifier's admission priority, model and the run's hold (`runHold.ts`). */
		priority?: AdmissionPriority;
		model?: LanguageModel;
		hold?: InterpretRunHold;
	}
): Promise<RoutedVerification> {
	const none = { isUnsendable: false, isCapped: false, isUnavailable: false };
	if (claims.length === 0) return { verdicts: new Map(), isIncomplete: false, ...none };
	const routing = await readRouting(ctx);
	const cap = routing?.policy.verifyClaimCapPerMessage ?? null;
	const sent = cap === null ? claims : claims.slice(0, cap);
	const isCapped = sent.length < claims.length;
	const plan = routing ? planClaimCheck(routing.policy) : null;
	const subject = subjectOf(opts.source, opts.mailboxId);
	// A resolution that throws is treated like a moved configuration: nothing is
	// verified now and a retry asks again; never the language verifier instead.
	const resolved =
		routing && plan && subject
			? await resolveBundleRung(ctx, routing).catch(() => 'stale' as const)
			: null;
	const root = opts.root;

	if (routing && plan?.mode === 'advisory' && subject && resolved !== null) {
		if (resolved === 'stale') {
			// The configuration moved under the run: nothing is verified now, a retry asks again.
			return { verdicts: new Map(), isIncomplete: true, ...none, isCapped };
		}
		if (resolved.rung === 'unavailable') {
			return { verdicts: new Map(), isIncomplete: false, ...none, isCapped, isUnavailable: true };
		}
		if (resolved.rung === 'decision') {
			const checked = await checkClaims(ctx, sent, { routing, plan, subject, resolved, root });
			return { ...checked, isCapped, isUnavailable: false };
		}
	}

	const verified = await verifyClaims(ctx, sent, {
		root,
		...(opts.priority ? { priority: opts.priority } : {}),
		...(opts.model ? { model: opts.model } : {}),
		...(opts.hold ? { hold: opts.hold } : {}),
	});
	if (routing && plan?.mode === 'shadow' && subject && isDecisionRung(resolved)) {
		await shadowClaims(ctx, sent, verified.verdicts, { routing, plan, subject, resolved, root });
	}
	return { ...verified, isCapped, isUnavailable: false };
}

function isDecisionRung(resolved: ResolvedRung | 'stale' | null): resolved is ResolvedRung {
	return resolved !== null && resolved !== 'stale' && resolved.rung === 'decision';
}

interface ClaimRun {
	readonly routing: RoutingContext;
	readonly plan: BundlePlan;
	readonly subject: BundleSubject;
	readonly resolved: ResolvedRung;
	readonly root: LlmRootContext;
}

/** One claim's decision question, through the runner and its claim. */
function askClaim(
	ctx: ActionCtx,
	run: ClaimRun,
	claim: VerifyClaim,
	extra: { baseline?: { verdict: string }; onCallError?: (error: unknown) => void } = {}
) {
	const built = claimCheckState(claim);
	if (!built) return null;
	return runBundle(ctx, {
		bundle: CLAIM_CHECK_BUNDLE,
		plan: run.plan,
		routing: run.routing,
		subject: run.subject,
		built,
		root: run.root,
		resolved: run.resolved,
		...extra,
	});
}

function isOutOfTime(outcome: { hasRun: boolean; why?: string }): boolean {
	return !outcome.hasRun && outcome.why === 'deadline';
}

/** Enforced: each claim asked on the decision plane; a claim without an answer stays unverified. */
async function checkClaims(
	ctx: ActionCtx,
	claims: readonly VerifyClaim[],
	run: ClaimRun
): Promise<Pick<RoutedVerification, 'verdicts' | 'isIncomplete' | 'isUnsendable' | 'refusal'>> {
	const verdicts = new Map<string, VerifyVerdict>();
	let isIncomplete = false;
	let isUnsendable = false;
	let refusal: AdmissionRefusalData | undefined;
	// A spend refusal is caught as itself, not as a failed check: it stops the
	// rest (they would be refused the same way) and the run reports it (D1).
	const onCallError = (error: unknown) => {
		refusal ??= admissionRefusalOf(error) ?? undefined;
	};
	for (const claim of claims) {
		const pending = askClaim(ctx, run, claim, { onCallError });
		if (pending === null) {
			isUnsendable = true;
			continue;
		}
		const outcome = await pending;
		const verdict = verdictOfLabel('labels' in outcome ? outcome.labels?.['verdict'] : undefined);
		if (verdict) verdicts.set(claim.id, verdict);
		else isIncomplete = true;
		// A spent action budget or a refusal stops the rest: they would end the same way.
		if (refusal || isOutOfTime(outcome)) {
			isIncomplete = true;
			break;
		}
	}
	return { verdicts, isIncomplete, isUnsendable, ...(refusal ? { refusal } : {}) };
}

/** Shadow: each verified claim asked beside the verifier, its verdict as the baseline. */
async function shadowClaims(
	ctx: ActionCtx,
	claims: readonly VerifyClaim[],
	verdicts: ReadonlyMap<string, VerifyVerdict>,
	run: ClaimRun
): Promise<void> {
	for (const claim of claims) {
		const verdict = verdicts.get(claim.id);
		if (!verdict) continue;
		try {
			const outcome = await askClaim(ctx, run, claim, {
				baseline: { verdict: labelOfVerdict(verdict) },
			});
			if (outcome && isOutOfTime(outcome)) return;
		} catch {
			// A shadow observation never changes verification.
		}
	}
}
