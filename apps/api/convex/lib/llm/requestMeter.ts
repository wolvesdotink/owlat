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
import type { LlmUsagePlane } from '../llmUsageTags';
import type { AdmissionPriority } from '../validators/aiRouting';

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
	/**
	 * Who waits on the whole request (ADR-0073, Phase 5). Every call under the
	 * root is admitted at this priority, whatever its own task's: a nested
	 * retrieval embedding under an assistant turn is the turn's interactive
	 * work, not pipeline work that may spend past the advisory reserve. Absent:
	 * each call's own priority (its target's, else its task's).
	 */
	readonly priority?: AdmissionPriority;
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
	/** Ran on the operator's own hardware (a local embedder or decision engine): costs nothing. */
	readonly isLocalEngine?: boolean;
	/** Decision rows: the request ran on the fallback hop. Each request keeps its own. */
	readonly isFallback?: boolean;
	/** Decision rows: the adapter that answered is calibrated. Each request keeps its own. */
	readonly isCalibrated?: boolean;
	/** The admission hold the request ran under (stamped by the meter, never by a dispatch). */
	readonly reservationId?: string;
}

export type LlmRequestInput = Omit<LlmRequestRecord, 'attempt' | 'reservationId'>;

export interface LlmCallMeterInit {
	readonly task?: AiTaskName;
	readonly root?: LlmRootContext;
	readonly requestId?: string;
	/**
	 * Absolute epoch ms by which every request of this call must be done: the
	 * tighter of the root's deadline and the running action's own budget
	 * (`./actionDeadline.ts`). Every dispatch enforces the time left.
	 */
	readonly deadlineAt?: number;
	/**
	 * Admission for the call's dispatches (`./admissionPort.ts`), installed by
	 * `analytics/meteredSpend.ts` `meterFor` in an action. Absent: no admission.
	 */
	readonly admission?: AdmissionPort;
	/**
	 * The call runs under a hold its caller took and settles (an embedding
	 * batch, a writer escalation): the dispatch reserves nothing more.
	 */
	readonly hasOuterHold?: boolean;
}

/** What one dispatch asks admission for (`./admissionPort.ts` computes it). */
export interface DispatchEstimate {
	readonly task: AiTaskName | undefined;
	readonly plane: LlmUsagePlane;
	readonly modelId: string;
	readonly endpoint?: string;
	/** Integer micro-USD the whole call may cost. */
	readonly microusd: number;
	/** Provider requests the call may make. */
	readonly maxRequests: number;
	/** The bound of the request the hold opens with (unknown usage is charged at it). */
	readonly requestBound: RequestBound;
}

/**
 * What one provider request may cost, keyed by the meter's request id and the
 * attempt number it will be recorded under. Without a key, the bound of any
 * request of the hold (a worst-case hold, a batch).
 */
export interface RequestBound {
	readonly requestId?: string;
	readonly attempt?: number;
	readonly microusd: number;
}

/** The meter's line to admission, installed by `analytics/meteredSpend.ts` `meterFor` in an action. */
export interface AdmissionPort {
	/** Reserve, or throw `AdmissionRefusedError`. Null: admitted with nothing held. */
	admit(estimate: DispatchEstimate): Promise<{ readonly reservationId: string } | null>;
	/**
	 * Grow a hold by one more provider request of `microusd` before it is sent
	 * (a retry, a tool round, a stream step), or throw `AdmissionRefusedError`.
	 */
	extend(reservationId: string, bound: RequestBound): Promise<void>;
	/** Release a hold whose dispatch sent nothing. Best effort: the sweep settles what it misses. */
	release(reservationId: string): Promise<void>;
}

/** One admission hold a dispatch of this meter opened. */
export interface MeterHold {
	readonly reservationId: string;
	/** The requests the hold covers. */
	readonly maxRequests: number;
	/** The dispatch that opened it has ended. */
	isClosed: boolean;
	/** Its settlement has been sent (or it was released). */
	isSettled: boolean;
}

/** Collects the provider requests of one logical call. */
export class LlmCallMeter {
	readonly requestId: string;
	readonly task: AiTaskName | undefined;
	readonly root: LlmRootContext | undefined;
	readonly deadlineAt: number | undefined;
	readonly admission: AdmissionPort | undefined;
	readonly hasOuterHold: boolean;
	private readonly records: LlmRequestRecord[] = [];
	private readonly persisted = new Set<number>();
	private readonly holdList: MeterHold[] = [];
	private openReservationId: string | undefined;

	constructor(init: LlmCallMeterInit = {}) {
		this.requestId = init.requestId ?? newRequestId();
		this.task = init.task;
		this.root = init.root;
		this.deadlineAt = tighterDeadline(init.deadlineAt, init.root?.deadlineAt);
		this.admission = init.admission;
		this.hasOuterHold = init.hasOuterHold === true;
	}

	/** Record one provider request. Its attempt number is its position in the call. */
	record(input: LlmRequestInput): LlmRequestRecord {
		const record = Object.freeze({
			...input,
			...(this.openReservationId ? { reservationId: this.openReservationId } : {}),
			attempt: this.records.length + 1,
		});
		this.records.push(record);
		return record;
	}

	/** A dispatch was admitted under `reservationId`: its requests carry the id until it closes. */
	openHold(reservationId: string, maxRequests: number): void {
		this.holdList.push({ reservationId, maxRequests, isClosed: false, isSettled: false });
		this.openReservationId = reservationId;
	}

	/** The dispatch of `reservationId` ended. Returns the requests it recorded. */
	closeHold(reservationId: string): number {
		const hold = this.holdList.find((candidate) => candidate.reservationId === reservationId);
		if (hold) hold.isClosed = true;
		if (this.openReservationId === reservationId) this.openReservationId = undefined;
		return this.requestsUnder(reservationId);
	}

	/** The attempt number the next recorded request will get. */
	get nextAttempt(): number {
		return this.records.length + 1;
	}

	/** Requests recorded under `reservationId`. */
	requestsUnder(reservationId: string): number {
		return this.records.filter((record) => record.reservationId === reservationId).length;
	}

	/** Holds whose dispatch has ended and whose settlement is not sent yet. */
	closedUnsettledHolds(): readonly MeterHold[] {
		return this.holdList.filter((hold) => hold.isClosed && !hold.isSettled);
	}

	markHoldSettled(reservationId: string): void {
		const hold = this.holdList.find((candidate) => candidate.reservationId === reservationId);
		if (hold) hold.isSettled = true;
	}

	/** Amend a recorded request that is not persisted yet (a throttle flag learned later). */
	amend(attempt: number, patch: Partial<LlmRequestInput>): void {
		const index = attempt - 1;
		const record = this.records[index];
		if (!record || this.persisted.has(attempt)) return;
		this.records[index] = Object.freeze({ ...record, ...patch, attempt });
	}

	/** Every request recorded so far. */
	get requests(): readonly LlmRequestRecord[] {
		return this.records;
	}

	/**
	 * The requests not persisted yet, in order. Reading them marks nothing: a
	 * writer calls {@link acknowledge} only once a batch is stored, so a failed
	 * write leaves its requests here for the next flush.
	 */
	pendingWrites(): LlmRequestRecord[] {
		return this.records.filter((record) => !this.persisted.has(record.attempt));
	}

	/** Mark requests as stored in the ledger. */
	acknowledge(records: readonly Pick<LlmRequestRecord, 'attempt'>[]): void {
		for (const record of records) this.persisted.add(record.attempt);
	}
}

/** The earlier of two optional absolute deadlines. */
export function tighterDeadline(
	left: number | undefined,
	right: number | undefined
): number | undefined {
	if (left === undefined) return right;
	if (right === undefined) return left;
	return Math.min(left, right);
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
