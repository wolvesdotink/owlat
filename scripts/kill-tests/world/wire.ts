/**
 * The JSON that crosses the world container's boundary: the orchestrator's
 * control requests (hold rules), the state it reads back, and the Convex
 * traffic the proxy observes. Checked here, in the world's own directory,
 * because the container mounts nothing else (compose.yml), so these guards
 * cannot come from the repository's shared helpers.
 *
 * A control request of the wrong shape is refused before it arms anything: a
 * hold rule that never matches would let the scenario run without its kill
 * and pass. A state answer of the wrong shape fails the run before the oracle
 * reads it.
 */

import type { HoldRule } from './smtpSink';

export class WireError extends Error {
	override name = 'WireError';
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/** `text` parsed to `unknown`; a body that is not JSON is a WireError. */
export function parseWire(text: string, label: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		throw new WireError(`${label} is not JSON`);
	}
}

function list(value: unknown, label: string): unknown[] {
	if (!Array.isArray(value)) throw new WireError(`${label} must be an array`);
	return value;
}

function fields(value: unknown, label: string): Record<string, unknown> {
	if (!isRecord(value)) throw new WireError(`${label} must be an object`);
	return value;
}

function text(value: unknown, label: string): string {
	if (typeof value !== 'string') throw new WireError(`${label} must be a string`);
	return value;
}

function integer(value: unknown, label: string): number {
	if (!Number.isSafeInteger(value)) throw new WireError(`${label} must be an integer`);
	return value as number;
}

function flag(value: unknown, label: string): boolean {
	if (typeof value !== 'boolean') throw new WireError(`${label} must be a boolean`);
	return value;
}

/** The body of `POST /control/smtp/hold`. */
export function decodeHoldRules(body: unknown): HoldRule[] {
	return list(fields(body, 'hold request')['rules'], 'rules').map((item, index) => {
		const rule = fields(item, `rules[${index}]`);
		const point = rule['point'];
		if (point !== 'data' && point !== 'dot')
			throw new WireError(`rules[${index}].point must be data or dot`);
		return { rcpt: text(rule['rcpt'], `rules[${index}].rcpt`), point };
	});
}

/** The body of `POST /control/convex/hold-ingest`: the IMAP UIDs to hold. */
export function decodeHoldUids(body: unknown): number[] {
	return list(fields(body, 'hold request')['uids'], 'uids').map((uid, index) => {
		const value = integer(uid, `uids[${index}]`);
		if (value < 1) throw new WireError(`uids[${index}] must be a positive UID`);
		return value;
	});
}

export interface SinkTransactionView {
	readonly rcpts: readonly string[];
	readonly bodyReceived: boolean;
}

export interface WebhookView {
	readonly event: string;
	readonly messageId: string;
	readonly backendStatus: number;
}

export interface IngestCallView {
	readonly messageId: string;
	readonly remoteUid: number;
	readonly outcome: 'stored' | 'duplicate' | 'other';
	readonly held: boolean;
}

/** What `GET /control/state` answers, as far as the scenarios read it. */
export interface WorldState {
	readonly smtp: readonly SinkTransactionView[];
	readonly webhooks: readonly WebhookView[];
	readonly ingestCalls: readonly IngestCallView[];
}

const OUTCOMES = new Set(['stored', 'duplicate', 'other']);

export function decodeWorldState(value: unknown): WorldState {
	const state = fields(value, 'world state');
	return {
		smtp: list(state['smtp'], 'smtp').map((item, index) => {
			const label = `smtp[${index}]`;
			const transaction = fields(item, label);
			return {
				rcpts: list(transaction['rcpts'], `${label}.rcpts`).map((rcpt, at) =>
					text(rcpt, `${label}.rcpts[${at}]`)
				),
				bodyReceived: flag(transaction['bodyReceived'], `${label}.bodyReceived`),
			};
		}),
		webhooks: list(state['webhooks'], 'webhooks').map((item, index) => {
			const label = `webhooks[${index}]`;
			const webhook = fields(item, label);
			return {
				event: text(webhook['event'], `${label}.event`),
				messageId: text(webhook['messageId'], `${label}.messageId`),
				backendStatus: integer(webhook['backendStatus'], `${label}.backendStatus`),
			};
		}),
		ingestCalls: list(state['ingestCalls'], 'ingestCalls').map((item, index) => {
			const label = `ingestCalls[${index}]`;
			const call = fields(item, label);
			const outcome = call['outcome'];
			if (typeof outcome !== 'string' || !OUTCOMES.has(outcome))
				throw new WireError(`${label}.outcome must be stored, duplicate or other`);
			return {
				messageId: text(call['messageId'], `${label}.messageId`),
				remoteUid: integer(call['remoteUid'], `${label}.remoteUid`),
				outcome: outcome as IngestCallView['outcome'],
				held: flag(call['held'], `${label}.held`),
			};
		}),
	};
}
