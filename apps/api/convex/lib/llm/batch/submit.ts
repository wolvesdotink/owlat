'use node';

/**
 * The consumer side of the batch path (ADR-0073, L14): a non-interactive
 * structured call asks {@link sendThroughBatch} first, and makes today's
 * real-time call whenever it answers false.
 *
 * It answers false, at the cost of one policy read, while `batchApi` is off
 * (the default). Otherwise also for a model whose adapter has no batch API
 * Owlat speaks (`./capture.ts` `batchRouteFor`), a request the batch API does
 * not take, a source whose batch item is already over (one batch attempt per
 * source), and a submission the provider did not take. It throws the spend
 * refusal the real-time call would have thrown, so the caller defers as it
 * does today. True: the request is held, recorded and with the provider (or
 * already was), and its result continues the work later
 * (`aiRouting/batchItems.ts`).
 */

import type { LanguageModel } from 'ai';
import { internal } from '../../../_generated/api';
import type { ActionCtx } from '../../../_generated/server';
import type { BatchConsumer } from '../../validators/aiRouting';
import type { LlmRootContext } from '../requestMeter';
import {
	AdmissionRefusedError,
	FALLBACK_OUTPUT_TOKENS,
	requestHoldMicrousd,
	utf8Bytes,
} from '../admissionPort';
import { modelMaxOutputTokens } from '../modelOutputLimits';
import { logInfo, logWarn } from '../../runtimeLog';
import { batchRouteFor, captureObjectRequest } from './capture';
import { batchCallOf } from './calls';
import { assertBatchable, type CapturedRequest } from './wire';
import { BatchSubmitError, batchTransport } from './transport';

export interface BatchCandidate {
	readonly consumer: BatchConsumer;
	readonly sourceId: string;
	/** The model the real-time call resolved. */
	readonly model: LanguageModel;
	readonly prompt: string;
	readonly root: LlmRootContext;
	/**
	 * Whether the source may go out at all, asked once the switch and the
	 * adapter allow it: a source its resume would refuse is not batched (its
	 * result would be billed and dropped) and stays real-time.
	 */
	readonly isEligible?: () => Promise<boolean>;
}

function numberField(body: Record<string, unknown>, ...names: string[]): number | undefined {
	for (const name of names) {
		const value = body[name];
		if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
	}
	return undefined;
}

/** The request's bound at the full real-time price: its bytes in, its output ceiling out. */
export function batchHoldMicrousd(
	provider: string,
	modelId: string,
	captured: CapturedRequest
): number {
	const body = captured.body;
	const turns = [body['messages'], body['input']].find(Array.isArray) as unknown[] | undefined;
	return requestHoldMicrousd({
		modelId,
		plane: 'language',
		endpoint: provider,
		bytes: utf8Bytes(JSON.stringify(body)),
		// The turns plus a system message.
		messages: (turns?.length ?? 1) + 1,
		outputTokens:
			numberField(body, 'max_output_tokens', 'max_tokens', 'max_completion_tokens') ??
			modelMaxOutputTokens(modelId) ??
			FALLBACK_OUTPUT_TOKENS,
	});
}

async function isBatchApiOn(ctx: ActionCtx): Promise<boolean> {
	try {
		const policy = await ctx.runQuery(internal.aiRouting.policy.getResolved, {});
		return policy.batchApi === 'enforce';
	} catch {
		// An unreadable policy is the default: off.
		return false;
	}
}

/** Send the call through its provider's batch API when the switch and the adapter allow it. */
export async function sendThroughBatch(
	ctx: ActionCtx,
	candidate: BatchCandidate
): Promise<boolean> {
	if (!(await isBatchApiOn(ctx))) return false;
	const route = await batchRouteFor(ctx, candidate.model);
	if (!route) return false;
	if (candidate.isEligible && !(await candidate.isEligible())) return false;
	const call = batchCallOf(candidate.consumer);
	let captured: CapturedRequest;
	try {
		captured = await captureObjectRequest(route, {
			task: call.task,
			schema: call.schema,
			prompt: candidate.prompt,
			...(call.temperature === undefined ? {} : { temperature: call.temperature }),
		});
		assertBatchable(route.provider, captured);
	} catch {
		return false;
	}

	const requestId = globalThis.crypto.randomUUID();
	let admitted;
	try {
		admitted = await ctx.runMutation(internal.aiRouting.batchItems.admitItem, {
			consumer: candidate.consumer,
			sourceId: candidate.sourceId,
			provider: route.provider,
			modelId: route.modelId,
			requestId,
			reservationId: globalThis.crypto.randomUUID(),
			root: candidate.root,
			holdMicrousd: batchHoldMicrousd(route.provider, route.modelId, captured),
		});
	} catch {
		// Whatever happened, the real-time call is admitted on its own.
		return false;
	}
	switch (admitted.kind) {
		case 'off':
		case 'used':
			return false;
		case 'pending':
			return true;
		case 'refused':
			throw new AdmissionRefusedError(admitted.reason, admitted.limit);
		case 'admitted':
			break;
	}

	let submitted;
	try {
		submitted = await batchTransport(route.provider, route.apiKey).submit(requestId, captured);
	} catch (error) {
		const isDefinite = error instanceof BatchSubmitError && error.isDefinite;
		await ctx.runMutation(internal.aiRouting.batchItems.refuseSubmission, {
			itemId: admitted.itemId,
			isDefinite,
		});
		logWarn('[batch] submission failed; the call goes real-time', {
			consumer: candidate.consumer,
			isDefinite,
		});
		return false;
	}
	try {
		await ctx.runMutation(internal.aiRouting.batchItems.confirmSubmitted, {
			itemId: admitted.itemId,
			providerBatchId: submitted.batchId,
			...(submitted.fileId ? { providerFileId: submitted.fileId } : {}),
		});
	} catch (error) {
		// Left `submitting`: the poller abandons it after its grace (the hold is
		// charged in full) and hands the source back to the real-time path.
		logWarn('[batch] submitted but not confirmed', { consumer: candidate.consumer, error });
	}
	logInfo('[batch] request sent through the batch API', {
		consumer: candidate.consumer,
		provider: route.provider,
	});
	return true;
}
