'use node';

/**
 * One attempt of an interpretation run (`run.ts`, split out at the file-size
 * cap): steps 1–10 of the run's module doc, plus read on arrival:
 * once the message is scoped, a Postbox arrival read asks
 * `arrivalDecide.decideArrivalDepth` how deep to go. `full` goes on as
 * before, `gist` hands over to `gist.ts`, and `count` / `none` were settled
 * by that mutation with no model call. A display-only source whose spend is
 * refused counts instead of retrying (§2.6).
 */

import type { ActionCtx } from '../../_generated/server';
import { internal } from '../../_generated/api';
import { admissionRefusalOf } from '../../lib/llm/admissionPort';
import { logWarn } from '../../lib/runtimeLog';
import type { InterpretMode } from '@owlat/shared/threadBrief';
import { INTERPRET_EXTRACTOR_VERSION } from './schema';
import { renderSegments } from './prompt';
import { extractOutput, prepareExtraction } from './extractOutput';
import { admitInterpretRun, type InterpretRunHold } from './runHold';
import { resolveLanguageModel } from '../../lib/llmProvider';
import {
	finish,
	RESTART_ERROR_CODE,
	type InterpretArgs,
	type InterpretRunResult,
	type Restart,
	type RunRecord,
} from './runShape';
import { groundProposals } from './ground';
import { isInterpretationEligible, isSecurityMail, isShortMail } from './eligibility';
import { contentRevisionOf, segmentScoped } from './scope';
import { scopeForInterpretation } from './scopeLoad';
import { buildInterpretInput, runStatusOf, toReduceResult, verifyClaimsOf } from './pipeline';
import { needsReplyProjectionOf } from './needsReplyProjection';
import { interpretRoot } from './verify';
import { planVerification, verifyHoldPlanOf, verifyRouted } from './verifyRoute';
import { apply as applyRecord } from './runApply';
import type { ReserveRunAllocations } from '../../aiRouting/admission';
import {
	arrivalAnswer,
	countArrival,
	decideArrival,
	isArrivalRead,
	settledAnswer,
} from './arrivalRun';
import type { InterpretGateVerdict } from './gate';
import { runGist } from './gist';
import { isRetryDue } from './retry';
import { guardAllowsInterpretation } from '../../agent/steps/security_scan/guard';

type Loaded = NonNullable<Awaited<ReturnType<typeof loadState>>>;

function loadState(ctx: ActionCtx, args: InterpretArgs) {
	return ctx.runQuery(internal.mail.interpret.load.loadForInterpretation, { source: args.source });
}

/** Write the run's record through the reducer (`./runApply.ts`), reloading while stale. */
function apply(ctx: ActionCtx, args: InterpretArgs, loaded: Loaded, record: RunRecord) {
	return applyRecord(ctx, args, loaded, record, () => loadState(ctx, args));
}

export async function runOnce(
	ctx: ActionCtx,
	args: InterpretArgs
): Promise<InterpretRunResult | Restart> {
	const loaded = await loadState(ctx, args);
	if (!loaded) return { status: 'gone' };
	const mode: InterpretMode = loaded.mode;

	// A fenced thread (staleFence.ts) is not read: nothing is recorded (a record
	// would rebuild what the fence hides), and the source stops being outstanding.
	const source = { source: args.source };
	if (await ctx.runQuery(internal.mail.interpret.staleFence.isSourceFenced, source)) {
		await ctx.runMutation(internal.mail.interpret.outstanding.settleRecorded, source);
		return {
			status: 'skipped',
			isReplayed: false,
			createdItemIds: [],
			errorCode: 'interpretation_fenced',
		};
	}

	// A bulk-stranger candidate whose thread category is still provisional
	// (PR-4): wait for the category refinement, bounded, instead of deciding
	// the bulk rule on the baseline label. Only the deferral is recorded, and
	// it ends the lease; settled meanwhile, the run reads again, still leased.
	if (loaded.categoryPendingUntil !== undefined) {
		const waited = await ctx.runMutation(internal.mail.interpret.categoryDefer.deferForCategory, {
			source: args.source,
			until: loaded.categoryPendingUntil,
			...(args.leaseToken ? { leaseToken: args.leaseToken } : {}),
		});
		if (waited.kind === 'gone') return { status: 'gone' };
		if (waited.kind === 'settled') return { restart: 'categorySettled' };
		return { status: 'wait', retryAt: waited.until };
	}

	const eligible = loaded.eligibility
		? isInterpretationEligible(loaded.eligibility, { direction: loaded.direction })
		: ({ isEligible: false, skipReason: 'ineligible', detail: 'no_snapshot' } as const);
	if (!eligible.isEligible) {
		return finish(
			await apply(ctx, args, loaded, {
				contentRevision: 'skip',
				status: 'skipped',
				skipReason: eligible.skipReason,
				errorCode: eligible.detail,
			}),
			{ errorCode: eligible.detail }
		);
	}

	// A Team message whose scan skipped the model guard gets it
	// before this generative consumer; one it flags is not interpreted.
	let isGuardClear: boolean;
	try {
		isGuardClear = await guardAllowsInterpretation(ctx, args.source, args.root?.deadlineAt);
	} catch (error) {
		// The late guard was refused by spend admission: a budget deferral.
		const refusal = admissionRefusalOf(error);
		if (!refusal) throw error;
		const budgetRefusal = { reason: refusal.reason, limit: refusal.limit };
		const deferred = { contentRevision: 'unread', status: 'failed' as const, errorCode: 'budget' };
		return finish(await apply(ctx, args, loaded, { ...deferred, budgetRefusal }), {
			errorCode: 'budget',
			budgetRefusal,
		});
	}
	if (!isGuardClear) {
		const skip = { skipReason: 'security' as const, errorCode: 'guard_flagged' };
		const record = { contentRevision: 'skip', status: 'skipped' as const, ...skip };
		return finish(await apply(ctx, args, loaded, record), { errorCode: skip.errorCode });
	}

	let contentRevision = 'unread';
	let retryCount: number | undefined;
	// The run's one spend hold, settled however the run ends (`runHold.ts`).
	let hold: InterpretRunHold | undefined;
	// Read on arrival: how a display-only read settles a spend refusal (§2.6).
	let countOnRefusal: (() => Promise<InterpretRunResult>) | null = null;
	try {
		const scoped = await scopeForInterpretation(ctx, args.source);
		if (!scoped) return { status: 'gone' };
		if (!scoped.ok) {
			return finish(
				await apply(ctx, args, loaded, {
					contentRevision: scoped.skipReason,
					status: 'skipped',
					skipReason: scoped.skipReason,
					...('detail' in scoped ? { errorCode: scoped.detail } : {}),
				}),
				'detail' in scoped ? { errorCode: scoped.detail } : {}
			);
		}
		// Every attempt is checked against the body it read (review round 2 F1).
		const sourceVersion = scoped.sourceVersion;
		const { segmented, isTruncated } = segmentScoped(scoped);
		contentRevision = await contentRevisionOf(segmented);
		const sourceManifest = {
			segments: segmented.segments.map((s) => ({
				id: s.id,
				kind: s.kind,
				start: s.start,
				end: s.end,
			})),
			isUncertain: segmented.uncertain,
		};

		// Reuse only on an EXACT match (review round 3 P3): the source's counted
		// extraction (its newest attempt) is for this content revision,
		// extractor version and mode. Then a complete one is reported as it
		// stands, an incomplete one is repaired once its retry is due. Anything
		// else (an older revision current again, another mode) re-extracts.
		const counted = loaded.counted;
		const isExact =
			!!counted &&
			counted.isApplied &&
			counted.contentRevision === contentRevision &&
			counted.extractorVersion === INTERPRET_EXTRACTOR_VERSION &&
			counted.mode === mode;
		// Admitted attempts (model calls) for this revision so far (round 4 M5):
		// gate refusals carry the count unchanged, every admitted attempt adds one.
		const priorAttempts = counted && isExact ? (counted.retryCount ?? 0) : 0;
		if (counted && isExact) {
			const isFinished = counted.status === 'complete' || counted.status === 'skipped';
			const isCurrentRead =
				loaded.current?.interpretationId === counted.interpretationId || !counted.hasPayload;
			if ((isFinished && isCurrentRead) || (!isFinished && !isRetryDue(counted, Date.now()))) {
				const good = loaded.current?.hasPayload ? loaded.current : null;
				// A reused result is an outcome: the source is no longer outstanding.
				await ctx.runMutation(internal.mail.interpret.outstanding.settleRecorded, {
					source: args.source,
				});
				const stored =
					good && good.contentRevision === contentRevision
						? await ctx.runQuery(internal.mail.interpret.load.readStoredResult, {
								interpretationId: good.interpretationId,
							})
						: null;
				return {
					status: counted.status,
					isReplayed: true,
					interpretationId: counted.interpretationId,
					createdItemIds: [],
					...(stored ? { projection: needsReplyProjectionOf(stored, loaded.ownerLocale) } : {}),
					...(counted.errorCode ? { errorCode: counted.errorCode } : {}),
					...(counted.nextRetryAt !== undefined ? { retryAt: counted.nextRetryAt } : {}),
					// The stored refusal: a caller that defers or holds on it does so again.
					...(counted.budgetRefusal ? { budgetRefusal: counted.budgetRefusal } : {}),
				};
			}
		}
		// Read on arrival: how deep an arrival read goes, decided now
		// that the message is scoped. `count` / `none` were settled by the decision.
		const arrivalArgs = isArrivalRead(args, loaded) ? args : null;
		const arrival = arrivalArgs
			? await decideArrival(
					ctx,
					arrivalArgs,
					{ subject: scoped.subject, segmented, sourceVersion },
					loaded.brief.deletionEpoch
				)
			: null;
		if (arrivalArgs && arrival?.kind === 'gist') return await runGist(ctx, arrivalArgs, loaded);
		if (arrival && arrival.kind !== 'full' && arrival.kind !== 'gist')
			return arrivalAnswer(arrival);
		// A display-only read whose spend is refused from here on counts (§2.6).
		countOnRefusal =
			arrivalArgs && arrival?.kind === 'full' && arrival.isDisplayOnly
				? () => countArrival(ctx, arrivalArgs, 'budget', loaded.brief.deletionEpoch)
				: null;
		retryCount = priorAttempts + 1;
		const attempt = {
			...(retryCount !== undefined ? { retryCount } : {}),
			...(sourceVersion ? { sourceVersion } : {}),
		};

		// A display-only arrival read asks the gate in a mutation that counts it
		// on a budget refusal (Sol r2 F4); everything else asks as before.
		let gate: InterpretGateVerdict;
		if (countOnRefusal && arrivalArgs) {
			const gated = await ctx.runMutation(internal.mail.interpret.arrivalHold.gateOrCount, {
				source: { kind: 'mail', id: arrivalArgs.source.id },
				...(args.leaseToken ? { leaseToken: args.leaseToken } : {}),
				deletionEpoch: loaded.brief.deletionEpoch,
				mode,
			});
			if (gated.isCounted) return settledAnswer('count');
			gate = gated.verdict;
		} else {
			gate = await ctx.runQuery(internal.mail.interpret.gate.checkAllowed, { mode });
		}
		if (!gate.isAllowed) {
			if (gate.code === 'budget' && countOnRefusal) return await countOnRefusal();
			const gateRefusal =
				gate.code === 'budget' ? { reason: gate.reason, limit: gate.limit } : undefined;
			return finish(
				await apply(ctx, args, loaded, {
					contentRevision,
					status: 'failed',
					errorCode: gate.code,
					sourceManifest,
					...(sourceVersion ? { sourceVersion } : {}),
					// A refusal is not an admitted attempt: the count stays.
					retryCount: priorAttempts,
					...(gateRefusal ? { budgetRefusal: gateRefusal } : {}),
				}),
				{ errorCode: gate.code, ...(gateRefusal ? { budgetRefusal: gateRefusal } : {}) }
			);
		}

		const input = buildInterpretInput({
			mode,
			segmented,
			sentAt: loaded.sourceAt,
			timezone: loaded.timezone,
			contentRevision,
			participants: loaded.participants,
			openItems: loaded.openItems,
			isItemsOverflow: loaded.isItemsOverflow,
			currentFacts: loaded.currentFacts,
			isFactsOverflow: loaded.isFactsOverflow,
			locales: loaded.locales,
		});
		const { truncatedSegmentIds } = renderSegments(input.message.segments);
		const root = args.root ?? interpretRoot(args.source);
		// Spend admission: brief mode is background work, so its
		// holds stop at the advisory reserve like its gate; actions mode feeds
		// the Team pipeline.
		const priority = mode === 'brief' ? 'background' : 'pipeline';
		const prepared = await prepareExtraction(ctx, input, mode);
		const verifyModel = await resolveLanguageModel(ctx, 'mail.verify');
		// The verification path (cap, language verifier or claim checks), decided
		// now so the hold below covers exactly it (`./verifyRoute.ts`, Sol r2 F2).
		const source = {
			source: args.source,
			...(loaded.mailboxId ? { mailboxId: loaded.mailboxId } : {}),
		};
		const verifyPlan = await planVerification(ctx, source);
		// One hold for the extraction and that verification, before anything
		// is bought (Sol r4): refused, the whole run defers, backed off, with no
		// retry spent; admitted, no call of the run can be refused halfway.
		try {
			const verify = verifyHoldPlanOf(verifyPlan);
			hold = await admitInterpretRun(ctx, {
				extract: prepared,
				verifyModel,
				verify,
				root,
				priority,
				// A display-only arrival read: a refused hold counts in the refusing
				// mutation itself (Sol r1 F13); the catch below only reports it.
				...(countOnRefusal && arrivalArgs
					? {
							reserve: (allocations: ReserveRunAllocations) =>
								ctx.runMutation(internal.mail.interpret.arrivalHold.reserveArrivalRun, {
									allocations,
									source: { kind: 'mail', id: arrivalArgs.source.id },
									...(args.leaseToken ? { leaseToken: args.leaseToken } : {}),
									deletionEpoch: loaded.brief.deletionEpoch,
								}),
						}
					: {}),
			});
		} catch (error) {
			const refusal = admissionRefusalOf(error);
			if (!refusal) throw error;
			if (countOnRefusal) return await countOnRefusal();
			const budgetRefusal = { reason: refusal.reason, limit: refusal.limit };
			const deferrals = (isExact ? (counted?.budgetDeferrals ?? 0) : 0) + 1;
			return finish(
				await apply(ctx, args, loaded, {
					contentRevision,
					status: 'failed',
					errorCode: 'budget',
					sourceManifest,
					...(sourceVersion ? { sourceVersion } : {}),
					retryCount: priorAttempts,
					budgetDeferrals: deferrals,
					budgetRefusal,
				}),
				{ errorCode: 'budget', budgetRefusal }
			);
		}
		// A full read the depth decision did not count (an upgrade, a predecessor,
		// an open): its arrival record counts the call (Sol r3 F2). Replays never
		// get here (the dedupe above).
		if (!arrival && args.source.kind === 'mail' && loaded.direction === 'inbound') {
			await ctx.runMutation(internal.mail.interpret.arrivalHold.noteFullReadCall, {
				messageId: args.source.id,
			});
		}
		const output = await extractOutput(ctx, prepared, { root, priority, hold });
		const grounding = groundProposals(output, segmented);
		const ownAddresses = new Set(loaded.ownAddresses);

		const itemText = new Map(loaded.openItems.map((i) => [i.id, i.assertion]));
		const factText = new Map(loaded.currentFacts.map((f) => [f.id, f.assertion]));
		const claims = verifyClaimsOf(grounding, segmented.canonicalText, {
			participants: loaded.participants,
			ownAddresses,
			itemText: (id) => itemText.get(id),
			factText: (id) => factText.get(id),
		});
		// The routing policy's claim cap and claim-check switch (`./verifyRoute.ts`).
		const verified = await verifyRouted(ctx, claims, verifyPlan, {
			root,
			priority,
			model: verifyModel,
			hold,
		});

		const freshText = segmented.segments
			.filter((s) => s.kind === 'fresh')
			.map((s) => segmented.canonicalText.slice(s.start, s.end))
			.join('\n');
		const latestSuppressed =
			mode !== 'brief'
				? undefined
				: isSecurityMail({ subject: scoped.subject, freshText })
					? ('security' as const)
					: isShortMail({
								freshChars: freshText.length,
								threadMessageCount: loaded.threadMessageCount,
						  })
						? ('short' as const)
						: undefined;

		const result = toReduceResult(output, grounding, {
			mode,
			canonicalText: segmented.canonicalText,
			participants: loaded.participants,
			ownAddresses,
			timezone: loaded.timezone,
			sentAt: loaded.sourceAt,
			verdicts: verified.verdicts,
			checked: new Set(claims.map((c) => c.id)),
			...(latestSuppressed ? { latestSuppressed } : {}),
		});
		const run = runStatusOf({
			grounding,
			output,
			isItemsOverflow: loaded.isItemsOverflow,
			isFactsOverflow: loaded.isFactsOverflow,
			truncatedSegmentIds,
			isVerifyIncomplete: verified.isIncomplete,
			isVerifyUnsendable: verified.isUnsendable,
			isVerifyCapped: verified.isCapped,
			isVerifyUnavailable: verified.isUnavailable,
			isBodyIncomplete: scoped.omitted.includes('body_unavailable'),
			isBodyTruncated: isTruncated,
		});
		const runErrorCode = run.errorCode;
		// Not expected under the run's hold; when it happens the verification is an
		// ordinary incomplete one, and the refusal is reported (Sol r4 F2) and
		// stored, so a replay reports it too (Sol r2 F1).
		const verifyRefusal = verified.refusal
			? { reason: verified.refusal.reason, limit: verified.refusal.limit }
			: undefined;
		const outcome = await apply(ctx, args, loaded, {
			contentRevision,
			status: run.status,
			...(runErrorCode ? { errorCode: runErrorCode } : {}),
			sourceManifest,
			coverage: {
				segmentsRead: output.coverage.segmentsRead.slice(0, 50),
				isUncertain: output.coverage.uncertain,
				isOverflow: output.coverage.overflow,
			},
			result,
			...attempt,
			...(verifyRefusal ? { budgetRefusal: verifyRefusal } : {}),
		});
		return finish(outcome, {
			projection: needsReplyProjectionOf(result, loaded.ownerLocale),
			...(runErrorCode ? { errorCode: runErrorCode } : {}),
			...(verifyRefusal ? { budgetRefusal: verifyRefusal } : {}),
		});
	} catch (error) {
		// Spend admission refused the model call after the gate passed (the
		// request did not fit, or another call took the headroom): a budget
		// deferral like the gate's, not a model error, and no retry is spent.
		const refusal = admissionRefusalOf(error);
		if (refusal && countOnRefusal)
			return await countOnRefusal().catch(() => ({ status: 'gone' as const }));
		const isBudget = refusal !== null;
		const errorCode = isBudget ? 'budget' : 'model_error';
		const budgetRefusal = refusal ? { reason: refusal.reason, limit: refusal.limit } : undefined;
		// Only the first line: a validation error goes on to print its argument.
		logWarn(
			'[interpret] run failed:',
			error instanceof Error ? error.message.split('\n', 1)[0] : 'non-Error thrown'
		);
		try {
			const attempts = isBudget && retryCount !== undefined ? retryCount - 1 : retryCount;
			return finish(
				await apply(ctx, args, loaded, {
					contentRevision,
					status: 'failed',
					errorCode,
					...(attempts !== undefined ? { retryCount: attempts } : {}),
					...(budgetRefusal ? { budgetRefusal } : {}),
				}),
				{ errorCode, ...(budgetRefusal ? { budgetRefusal } : {}) }
			);
		} catch {
			return {
				status: 'failed',
				isReplayed: false,
				createdItemIds: [],
				errorCode,
				...(budgetRefusal ? { budgetRefusal } : {}),
			};
		}
	} finally {
		await hold?.settle();
	}
}

/**
 * The body (or the scope) kept changing under every attempt: record that,
 * with no claims written, and keep the last good read (the reducer does).
 */
export async function recordRestartFailure(
	ctx: ActionCtx,
	args: InterpretArgs,
	reason: Restart['restart']
): Promise<InterpretRunResult> {
	const errorCode = RESTART_ERROR_CODE[reason];
	const loaded = await loadState(ctx, args);
	if (!loaded) return { status: 'gone' };
	const out = finish(
		await apply(ctx, args, loaded, { contentRevision: 'unread', status: 'failed', errorCode }),
		{ errorCode }
	);
	return 'restart' in out
		? { status: 'failed', isReplayed: false, createdItemIds: [], errorCode }
		: out;
}
