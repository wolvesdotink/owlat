/**
 * The action side of spend admission (ADR-0073, Phase 1b): how an action
 * reserves before it dispatches, and the port `meterFor` puts on every meter
 * it builds (`./meteredSpend.ts`).
 *
 * {@link reserveHold} is the one place an action asks `aiRouting/admission.ts`
 * `reserve`. It skips the round trip when nothing bounds the call (no ceiling
 * configured and not shadow traffic, today's behaviour), and it fails closed:
 * a reserve that cannot complete is `spend_unverifiable` (D1, #1333), never an
 * admitted call. Runtime-neutral.
 */

import { internal } from '../_generated/api';
import type { ActionCtx } from '../_generated/server';
import type { AiTaskName } from '@owlat/shared/aiRouting';
import { resolveBudgetConfig } from './spendBudget';
import {
	AdmissionRefusedError,
	type AdmissionPort,
	type DispatchEstimate,
} from '../lib/llm/admissionPort';
import { taskPolicy } from '../lib/llm/taskPolicy';
import type { LlmRootContext, RequestBound } from '../lib/llm/requestMeter';
import type { LlmUsagePlane } from '../lib/llmUsageTags';
import type { AdmissionPriority, BudgetClass } from '../lib/validators/aiRouting';

/** What an action needs to reserve: the mutation runner. */
type ReserveCtx = Pick<ActionCtx, 'runMutation'>;

/** The longest an action runs (Convex's action limit): a hold outlives it by {@link HOLD_GRACE_MS}. */
const ACTION_LIMIT_MS = 10 * 60 * 1000;

/** How long a hold outlives its call's deadline before the sweep settles it as dead. */
export const HOLD_GRACE_MS = 10 * 60 * 1000;

/** Whether admission has anything to bound for a call of `budgetClass` in this deployment. */
export function admissionApplies(budgetClass: BudgetClass): boolean {
	if (budgetClass === 'shadow') return true;
	const config = resolveBudgetConfig();
	return config.dailyUsd > 0 || config.monthlyUsd > 0;
}

export interface HoldRequest {
	readonly task: AiTaskName;
	readonly plane: LlmUsagePlane;
	readonly budgetClass: BudgetClass;
	readonly priority: AdmissionPriority;
	readonly root: LlmRootContext | undefined;
	readonly microusd: number;
	readonly maxRequests: number;
	/** The bound of the request the hold opens with. */
	readonly requestBound: RequestBound;
	/** Further requests' own bounds, keyed (a hold over several calls). */
	readonly requestBounds?: readonly RequestBound[];
	readonly modelId?: string;
	readonly endpoint?: string;
	/** Absolute ms by which the call is over (its deadline); the hold expires a grace period later. */
	readonly deadlineAt?: number;
}

function hasRunMutation(ctx: object): ctx is ReserveCtx {
	return typeof (ctx as { runMutation?: unknown }).runMutation === 'function';
}

/**
 * Reserve `request.microusd`, or throw {@link AdmissionRefusedError}. Returns
 * the hold's id, or null when nothing needed holding (no ceiling, a $0 call).
 */
export async function reserveHold(
	ctx: object,
	request: HoldRequest
): Promise<{ reservationId: string } | null> {
	if (!admissionApplies(request.budgetClass)) return null;
	if (!hasRunMutation(ctx)) throw new AdmissionRefusedError('spend_unverifiable', 'unverifiable');
	const reservationId = globalThis.crypto.randomUUID();
	const now = Date.now();
	const deadlineAt = request.deadlineAt ?? now + ACTION_LIMIT_MS;
	let verdict;
	try {
		verdict = await ctx.runMutation(internal.aiRouting.admission.reserve, {
			reservationId,
			rootRequestId: request.root?.rootRequestId ?? `call:${reservationId}`,
			...(request.root?.parentCallId ? { parentCallId: request.root.parentCallId } : {}),
			plane: request.plane,
			task: request.task,
			budgetClass: request.budgetClass,
			priority: request.priority,
			heldMicrousd: request.microusd,
			maxRequests: request.maxRequests,
			requestBound: request.requestBound,
			...(request.requestBounds?.length ? { requestBounds: [...request.requestBounds] } : {}),
			...(request.modelId ? { modelId: request.modelId } : {}),
			...(request.endpoint ? { endpoint: request.endpoint } : {}),
			expiresAt: Math.max(deadlineAt, now) + HOLD_GRACE_MS,
		});
	} catch {
		// The reservation state could not be written or read: refuse (D1).
		throw new AdmissionRefusedError('spend_unverifiable', 'unverifiable');
	}
	if (!verdict.isAdmitted) throw new AdmissionRefusedError(verdict.reason, verdict.limit);
	return verdict.isHeld ? { reservationId } : null;
}

/** Release a hold that spent nothing. Best effort: the expiry sweep settles a hold this misses. */
export async function releaseHold(ctx: object, reservationId: string): Promise<void> {
	if (!hasRunMutation(ctx)) return;
	await ctx
		.runMutation(internal.aiRouting.admission.release, { reservationId })
		.catch(() => undefined);
}

/** The port a meter built in an action admits its dispatches through. */
export function dispatchAdmissionPort(
	ctx: object,
	target: {
		readonly budgetClass?: BudgetClass;
		readonly priority?: AdmissionPriority;
		readonly root?: LlmRootContext;
	},
	task: AiTaskName | undefined,
	deadlineAt: number | undefined
): AdmissionPort | undefined {
	if (!hasRunMutation(ctx)) return undefined;
	return {
		async admit(estimate: DispatchEstimate) {
			const policy = task ? taskPolicy(task) : undefined;
			const budgetClass = target.budgetClass ?? policy?.budgetClass ?? 'standard';
			if (!admissionApplies(budgetClass)) return null;
			// Every production feature maps to a task (`lib/llm/taskPolicy.ts`); a
			// call nobody can classify is not admitted against a ceiling.
			if (!task || !policy) throw new AdmissionRefusedError('spend_unverifiable', 'unverifiable');
			if (estimate.microusd <= 0) return null;
			return reserveHold(ctx, {
				task,
				plane: estimate.plane,
				budgetClass,
				priority: target.priority ?? policy.priority,
				root: target.root,
				microusd: estimate.microusd,
				maxRequests: estimate.maxRequests,
				requestBound: estimate.requestBound,
				modelId: estimate.modelId,
				...(estimate.endpoint ? { endpoint: estimate.endpoint } : {}),
				...(deadlineAt === undefined ? {} : { deadlineAt }),
			});
		},
		extend: (reservationId: string, bound: RequestBound) => extendHold(ctx, reservationId, bound),
		release: (reservationId: string) => releaseHold(ctx, reservationId),
	};
}

/** Grow a hold by one request, or throw {@link AdmissionRefusedError}; fails closed. */
export async function extendHold(
	ctx: object,
	reservationId: string,
	requestBound: RequestBound
): Promise<void> {
	if (!hasRunMutation(ctx)) throw new AdmissionRefusedError('spend_unverifiable', 'unverifiable');
	let verdict;
	try {
		verdict = await ctx.runMutation(internal.aiRouting.admission.extend, {
			reservationId,
			requestBound,
		});
	} catch {
		throw new AdmissionRefusedError('spend_unverifiable', 'unverifiable');
	}
	if (!verdict.isAdmitted) throw new AdmissionRefusedError(verdict.reason, verdict.limit);
}
