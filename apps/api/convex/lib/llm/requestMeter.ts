/**
 * Per-request metering for one logical model call (ADR-0073, Phase 1a).
 *
 * A logical call (one `runLlmObject`, one tool loop, one stream, one decision,
 * one embedding) can make several provider requests: retries, tool rounds, a
 * decision adapter's own inner retries. The ledger keeps ONE ROW PER PROVIDER
 * REQUEST, so the dispatch that makes the request records it here, and the
 * caller's spend helper (`analytics/meteredSpend.ts`) writes what the meter
 * holds. A meter remembers which records it already handed out, so a success
 * path and a failure path that both flush it still write each request once.
 *
 * The meter also carries the call's routing context: its task (which sets the
 * output, reasoning and deadline limits the dispatch enforces, from
 * `lib/llm/taskPolicy.ts`) and its root request (which groups the rows of one
 * inbound message or one user action). It is an explicit argument, never
 * ambient state.
 *
 * Pure and runtime-neutral: V8 steps and Node dispatch both use it.
 */

import type { AiTaskName } from '@owlat/shared/aiRouting';
import type { TokenUsage } from '../../agent/steps/types';

/**
 * The outermost request a call serves, and the call that issued it. The id is
 * `<path>:<id>` (see {@link rootRequest}), so a report can group rows by path
 * (`mail/interpret/__eval__/callInventory.ts` reads the prefix).
 */
export interface LlmRootContext {
	readonly rootRequestId: string;
	/** The `requestId` of the call that issued this one (a nested tool, a self-check). */
	readonly parentCallId?: string;
	/** Absolute epoch ms after which no call under this root may still run. */
	readonly deadlineAt?: number;
}

/**
 * The paths a root id names. `team` and `postbox` are one inbound message
 * (keyed by its id, so every action that works on it shares the root);
 * `postbox_thread` is background Postbox work keyed only by its thread;
 * `postbox_action` is one user-triggered Postbox AI action; the rest are one
 * invocation of their surface.
 */
export const ROOT_REQUEST_PATHS = [
	'team',
	'postbox',
	'postbox_thread',
	'postbox_action',
	'knowledge',
	'file',
	'assistant',
	'analytics',
	'rules',
	'translate',
	'settings',
	'voice_profile',
] as const;

export type RootRequestPath = (typeof ROOT_REQUEST_PATHS)[number];

/** The root of `id` under `path`: deterministic, so separate actions on one message share it. */
export function rootRequest(path: RootRequestPath, id: string): LlmRootContext {
	return { rootRequestId: `${path}:${id}` };
}

/**
 * The root of background Postbox work on a thread: the message it was
 * scheduled for when known, else the thread.
 */
export function postboxRoot(threadId: string, latestMessageId: string | undefined): LlmRootContext {
	return latestMessageId === undefined
		? rootRequest('postbox_thread', threadId)
		: rootRequest('postbox', latestMessageId);
}

/** A fresh root for one invocation of a surface that has no natural id. */
export function newRootRequest(path: RootRequestPath): LlmRootContext {
	return rootRequest(path, newRequestId());
}

/** The root a nested call runs under: same root and deadline, parent set to the caller's call. */
export function childCall(root: LlmRootContext | undefined, parentCallId: string): LlmRootContext {
	return root
		? { ...root, parentCallId }
		: { rootRequestId: `orphan:${parentCallId}`, parentCallId };
}

function newRequestId(): string {
	return globalThis.crypto.randomUUID();
}

/** One provider request as the dispatch saw it. */
export interface LlmRequestRecord {
	/** 1-based provider request number within the meter's logical call. */
	readonly attempt: number;
	readonly outcome: 'ok' | 'failed';
	/** Billed usage the provider reported. Absent: none reported (the row is an estimate). */
	readonly usage?: TokenUsage;
	readonly cacheReadTokens?: number;
	readonly cacheWriteTokens?: number;
	readonly reasoningTokens?: number;
	/** Wall time of this request, in ms. */
	readonly latencyMs: number;
	/** The model the request was sent to (or the one an adapter reported). */
	readonly modelUsed?: string;
	/** Secret-free endpoint identity, when the dispatch knows it. */
	readonly endpoint?: string;
	/** Upstream pushed back (429/529). Decision rows only. */
	readonly isThrottled?: boolean;
}

export type LlmRequestInput = Omit<LlmRequestRecord, 'attempt'>;

export interface LlmCallMeterInit {
	readonly task?: AiTaskName;
	readonly root?: LlmRootContext;
	readonly requestId?: string;
}

/** Collects the provider requests of one logical call. */
export class LlmCallMeter {
	readonly requestId: string;
	readonly task: AiTaskName | undefined;
	readonly root: LlmRootContext | undefined;
	private readonly records: LlmRequestRecord[] = [];
	private written = 0;

	constructor(init: LlmCallMeterInit = {}) {
		this.requestId = init.requestId ?? newRequestId();
		this.task = init.task;
		this.root = init.root;
	}

	/** Record one provider request. Its attempt number is its position in the call. */
	record(input: LlmRequestInput): LlmRequestRecord {
		const record = Object.freeze({ ...input, attempt: this.records.length + 1 });
		this.records.push(record);
		return record;
	}

	/** Every request recorded so far. */
	get requests(): readonly LlmRequestRecord[] {
		return this.records;
	}

	/** The requests not handed out yet, marked handed out: each is written once. */
	takeUnwritten(): LlmRequestRecord[] {
		const pending = this.records.slice(this.written);
		this.written = this.records.length;
		return pending;
	}
}

/** Start timing one provider request; the returned function records it. */
export function startRequest(
	meter: LlmCallMeter | undefined,
	now: () => number = Date.now
): (input: Omit<LlmRequestInput, 'latencyMs'>) => void {
	const startedAt = now();
	return (input) => {
		meter?.record({ ...input, latencyMs: Math.max(0, now() - startedAt) });
	};
}
