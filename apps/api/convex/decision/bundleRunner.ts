'use node';

/**
 * The Phase 2 bundle runner (ADR-0073 §5 and §8): asks ONE registered bundle
 * about ONE message, once, on the rung the routing ladder picks, and stores the
 * answer as a decision artifact. It returns nothing a caller could route on:
 * every caller schedules it and moves on (D9).
 *
 * The order of work, each step refusing before anything is paid:
 *
 * 1. The rung (`lib/decision/routing.ts` `decisionRung`). An explicitly
 *    configured decision provider that cannot answer is terminal (D3). The
 *    message bundles have no language rung of their own: there, today's
 *    classifier call IS the rung.
 * 2. Admission (`./bundleAdmission.ts`): the D4 shadow allowance, or an
 *    advisory reservation. Nothing runs unadmitted.
 * 3. The artifact lease (`./artifacts.ts` `claim`): one worker per key, and an
 *    answered key is never asked again.
 * 4. ONE call: `runDecision` on the decision plane, with no fallback hop
 *    (inbound background work never takes a paid fallback, D3), or one
 *    fast-tier structured call on the language rung, both metered.
 * 5. The answer, projected to labels through the bundle's thresholds, is
 *    stored with its provenance and calibration stamp, and compared with
 *    today's source (`baseline`) and with sender memory (D12).
 */

import type { ActionCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import { meterLlmCall } from '../analytics/meteredSpend';
import { resolveDecisionConfig, type ResolvedDecisionPlane } from '../lib/decisionProvider';
import type { ResolvedDecisionProvider } from '../lib/decision/contract';
import { runDecision } from '../lib/decision/dispatch';
import { decisionRateLimiterPort } from '../lib/decision/ports';
import {
	DEFAULT_LANGUAGE_DECISION_DEADLINE_MS,
	mapAnswers,
	renderDecisionPrompt,
	renderDecisionSchema,
} from '../lib/decisionProviders/llm';
import type {
	DecisionEndpointProvenance,
	DecisionProviderKind,
} from '../lib/decisionProviders/types';
import { runLlmObject } from '../lib/llm/dispatch';
import { resolveLanguageModel } from '../lib/llmProvider';
import type { LlmRootContext } from '../lib/llm/requestMeter';
import type { AnswersFor, DecisionAnswer, QuestionSet } from '../lib/decision/questions';
import {
	agreementWith,
	DECISION_FEATURE,
	isAbstention,
	type DecisionBundle,
	type DecisionLabels,
} from '../lib/decision/bundles';
import { calibrationRevisionFor } from '../lib/decision/calibration';
import { stateContentHash, type BuiltDecisionState } from '../lib/decision/evidence';
import { resolveEndpointLocality } from '../lib/llm/endpointLocality';
import { resolvedPlaneIdentity } from '../lib/decision/configIdentity';
import {
	artifactKeyOf,
	decisionRung,
	type BundlePlan,
	type DecisionRung,
} from '../lib/decision/routing';
import { admitBundle, type BundleAdmission } from './bundleAdmission';
import type { RoutingContext } from './context';
import type { Id } from '../_generated/dataModel';
import type { AdmissionPriority } from '../lib/validators/aiRouting';

/** Same state, same questions, same answer: a decision is no place for sampling. */
const DECISION_TEMPERATURE = 0;

export type BundleSubject =
	| { readonly kind: 'inbound_message'; readonly inboundMessageId: Id<'inboundMessages'> }
	| {
			readonly kind: 'mail_message';
			readonly mailMessageId: Id<'mailMessages'>;
			readonly mailboxId: Id<'mailboxes'>;
	  };

export interface BundleRun<Q extends QuestionSet> {
	readonly bundle: DecisionBundle<Q>;
	/**
	 * The rung and plane the caller already resolved for this routing context
	 * (`resolveBundleRung`), for a caller asking many bundles at once (one claim
	 * check per claim). Absent: resolved here. The claim checks the snapshot
	 * either way.
	 */
	readonly resolved?: ResolvedRung;
	/** The master gate, when it is not the subject's default (Answer mode: `ai`). */
	readonly masterGate?: 'ai' | 'ai.agent';
	/** The admission priority of an advisory call; background when absent. */
	readonly priority?: AdmissionPriority;
	/**
	 * Called with a failed call's error after its lease is released, for an
	 * inline caller that must not swallow it (a spend refusal holds, defers or
	 * surfaces, D1). Throwing from it rethrows out of `runBundle`.
	 */
	readonly onCallError?: (error: unknown) => void;
	readonly plan: BundlePlan;
	readonly routing: RoutingContext;
	readonly subject: BundleSubject;
	/** The redacted state, whether it is complete, and the message fingerprint. */
	readonly built: BuiltDecisionState;
	readonly root: LlmRootContext;
	/** Today's source, in the bundle's label domain, for the shadow comparison. */
	readonly baseline?: DecisionLabels;
	/** The message's language, when known: the calibration stamp's language. */
	readonly language?: string;
}

export type BundleRunOutcome =
	| {
			readonly hasRun: true;
			readonly status: 'complete' | 'abstained' | 'failed';
			/** The answer's labels; absent when the call failed. */
			readonly labels?: DecisionLabels;
	  }
	| {
			readonly hasRun: false;
			readonly why: 'settled';
			/** The stored answer's labels, when the key holds a valid one. */
			readonly labels?: DecisionLabels;
	  }
	| {
			readonly hasRun: false;
			readonly why:
				| 'language_rung'
				| 'provider_unavailable'
				| 'busy'
				| 'gone'
				| 'excluded'
				| 'disabled'
				| 'stale'
				| 'policy_changed'
				| Extract<BundleAdmission, { isAdmitted: false }>['why'];
	  };

interface Answered<Q extends QuestionSet> {
	readonly answers: AnswersFor<Q>;
	readonly provider: DecisionProviderKind | 'language';
	readonly modelUsed?: string;
	readonly endpoint?: DecisionEndpointProvenance;
	readonly isAdapterCalibrated: boolean;
}

function subjectId(subject: BundleSubject): string {
	return subject.kind === 'inbound_message' ? subject.inboundMessageId : subject.mailMessageId;
}

/** The decision plane's one call: the gate's allowance, no fallback hop, metered per attempt. */
async function askDecisionPlane<Q extends QuestionSet>(
	ctx: ActionCtx,
	run: BundleRun<Q>,
	admitted: Extract<BundleAdmission, { isAdmitted: true }>,
	plane: ResolvedDecisionPlane
): Promise<Answered<Q>> {
	const allowance = await ctx.runMutation(internal.decision.gate.assertDecisionAllowed, {});
	// Exactly the provider the claim checked: built from the one resolution,
	// never resolved again (the configuration may have changed since).
	const provider: ResolvedDecisionProvider = {
		kind: plane.kind,
		config: plane.clientConfig,
		deadlineMs: plane.deadlineMs,
		...(plane.modelId ? { modelId: plane.modelId } : {}),
	};
	const result = await runDecision({
		feature: DECISION_FEATURE[run.plan.task],
		task: run.plan.task,
		root: run.root,
		state: run.built.state,
		questions: run.bundle.questions,
		provider,
		allowance,
		rateLimiter: decisionRateLimiterPort(ctx),
		...admitted.decision,
	});
	return {
		answers: result.answers,
		provider: result.provider,
		...(result.modelUsed ? { modelUsed: result.modelUsed } : {}),
		endpoint: result.provenance,
		isAdapterCalibrated: result.calibrated,
	};
}

/**
 * The language rung's one call: the bundle rendered as one fast-tier
 * structured call, the way the language-backed adapter renders it, metered
 * under the admitted target. Never calibrated.
 */
async function askLanguageRung<Q extends QuestionSet>(
	ctx: ActionCtx,
	run: BundleRun<Q>,
	admitted: Extract<BundleAdmission, { isAdmitted: true }>
): Promise<Answered<Q>> {
	const model = await resolveLanguageModel(ctx, 'classify');
	const { object, modelUsed } = await meterLlmCall(
		ctx,
		{ ...admitted.target, task: run.plan.task, root: run.root, plane: 'language' },
		(meter) =>
			runLlmObject({
				meter,
				model,
				schema: renderDecisionSchema(run.bundle.questions),
				prompt: renderDecisionPrompt(run.built.state, run.bundle.questions),
				temperature: DECISION_TEMPERATURE,
				abortSignal: AbortSignal.timeout(DEFAULT_LANGUAGE_DECISION_DEADLINE_MS),
			})
	);
	return {
		answers: mapAnswers(run.bundle.questions, object) as AnswersFor<Q>,
		provider: 'language',
		...(modelUsed ? { modelUsed } : {}),
		endpoint: 'llm-backed',
		isAdapterCalibrated: false,
	};
}

/** The ladder rung for a routing context, and the one plane resolution it was decided on. */
export interface ResolvedRung {
	readonly rung: DecisionRung;
	readonly plane: ResolvedDecisionPlane | null;
}

/**
 * Resolve the decision plane ONCE for a routing context and pick the rung.
 * `stale` when the resolution read another configuration than the routing
 * read saw: the rung would be decided on one config and the provider on
 * another.
 */
export async function resolveBundleRung(
	ctx: ActionCtx,
	routing: RoutingContext
): Promise<ResolvedRung | 'stale'> {
	// A plane that cannot even be resolved (an undecryptable key, say) is the
	// D3 case too: terminal, never a language call in its place.
	const plane = routing.isDecisionPlaneOn
		? await resolveDecisionConfig(ctx).catch(() => null)
		: null;
	if (plane !== null && plane.updatedAt !== routing.configUpdatedAt) return 'stale';
	const rung = decisionRung({
		isDecisionPlaneOn: routing.isDecisionPlaneOn,
		kind: plane?.kind ?? 'llm',
		isUnavailable:
			routing.isDecisionPlaneOn && (plane === null || plane.degradedFrom !== undefined),
	});
	return { rung, plane };
}

/** Ask `run.bundle` about one message and store the artifact. Never throws for a provider failure. */
export async function runBundle<Q extends QuestionSet>(
	ctx: ActionCtx,
	run: BundleRun<Q>
): Promise<BundleRunOutcome> {
	const { routing, plan, bundle } = run;
	const resolved = run.resolved ?? (await resolveBundleRung(ctx, routing));
	if (resolved === 'stale') return { hasRun: false, why: 'stale' };
	const { rung, plane } = resolved;
	if (rung === 'unavailable') return { hasRun: false, why: 'provider_unavailable' };
	if (rung === 'language' && !bundle.runsOnLanguageRung) {
		return { hasRun: false, why: 'language_rung' };
	}

	const admitted = await admitBundle(ctx, {
		task: plan.task,
		mode: plan.mode,
		subjectKey: subjectId(run.subject),
		feature: DECISION_FEATURE[plan.task],
		root: run.root,
		policyVersion: routing.policy.policyVersion,
		...(run.priority ? { priority: run.priority } : {}),
	});
	if (!admitted.isAdmitted) return { hasRun: false, why: admitted.why };

	// The endpoint this call will use, from the ONE resolution above: its rung,
	// whether it is the operator's own (ADR-0060 §9), and the flag and
	// configuration snapshot it was decided on. The claim checks them all, on
	// either rung; the call uses exactly this endpoint.
	const endpoint = {
		rung: rung === 'decision' ? ('decision' as const) : ('language' as const),
		isLocal:
			rung === 'decision' &&
			plane !== null &&
			resolveEndpointLocality(plane.kind, plane.clientConfig.baseUrl) === 'local',
		isDecisionPlaneOn: routing.isDecisionPlaneOn,
		...(routing.configUpdatedAt === undefined ? {} : { configUpdatedAt: routing.configUpdatedAt }),
	};
	const contentHash = stateContentHash(run.built.state);
	const artifactKey = artifactKeyOf({
		task: plan.task,
		subject: { kind: run.subject.kind, id: subjectId(run.subject) },
		contentHash,
		policyVersion: routing.policy.policyVersion,
		questionSetId: bundle.id,
		questionSetVersion: bundle.version,
	});
	const claim = await ctx.runMutation(internal.decision.artifacts.claim, {
		artifactKey,
		task: plan.task,
		kind: plan.mode,
		subjectKind: run.subject.kind,
		...(run.subject.kind === 'inbound_message'
			? { inboundMessageId: run.subject.inboundMessageId }
			: { mailMessageId: run.subject.mailMessageId, mailboxId: run.subject.mailboxId }),
		contentHash,
		policyVersion: routing.policy.policyVersion,
		rootRequestId: run.root.rootRequestId,
		endpoint,
		...(run.masterGate ? { masterGate: run.masterGate } : {}),
	});
	if (claim.outcome === 'settled') {
		const labels = await ctx.runQuery(internal.decision.artifacts.answeredLabels, { artifactKey });
		return { hasRun: false, why: 'settled', ...(labels ? { labels } : {}) };
	}
	if (claim.outcome !== 'claimed') return { hasRun: false, why: claim.outcome };
	const lease = { artifactKey, leaseExpiresAt: claim.leaseExpiresAt };

	try {
		const answered =
			rung === 'decision' && plane !== null
				? await askDecisionPlane(ctx, run, admitted, plane)
				: await askLanguageRung(ctx, run, admitted);
		const labels = bundle.project(answered.answers);
		const status = isAbstention(labels) ? 'abstained' : 'complete';
		const isAgreement = agreementWith(labels, run.baseline);
		const revision = calibrationRevisionFor(plan.task, run.language);
		await ctx.runMutation(internal.decision.artifacts.complete, {
			...lease,
			status,
			labels,
			answers: JSON.stringify(answered.answers satisfies Record<string, DecisionAnswer>),
			provenance: {
				provider: answered.provider,
				...(answered.modelUsed ? { modelUsed: answered.modelUsed } : {}),
				...(answered.endpoint ? { endpoint: answered.endpoint } : {}),
				questionSetId: bundle.id,
				questionSetVersion: bundle.version,
			},
			calibration: {
				isAdapterCalibrated: answered.isAdapterCalibrated,
				...(revision ? { calibrationRevision: revision } : {}),
				...(run.language ? { language: run.language } : {}),
			},
			contextVersion: rung === 'decision' ? resolvedPlaneIdentity(plane, true) : 'language',
			...(run.baseline ? { baseline: { ...run.baseline } } : {}),
			...(isAgreement === undefined ? {} : { isAgreement }),
			...(run.built.isComplete ? { memoryKey: run.built.contentFingerprint } : {}),
		});
		return { hasRun: true, status, labels };
	} catch (error) {
		console.warn(`[decision] ${bundle.id} for ${run.subject.kind} failed`, errorName(error));
		try {
			await ctx.runMutation(internal.decision.artifacts.fail, lease);
		} catch {
			// The lease lapses on its own; a later run may take the key.
		}
		run.onCallError?.(error);
		return { hasRun: true, status: 'failed' };
	}
}

/** The error's class name only: a provider message can quote the mail. */
function errorName(error: unknown): string {
	return error instanceof Error ? error.name : typeof error;
}
