/**
 * The path from both workers to the real Convex backend. The MTA's
 * `CONVEX_SITE_URL` and mail-sync's `CONVEX_URL` / `CONVEX_SITE_URL` point
 * here, and every request is forwarded byte for byte (signatures included) to
 * the self-hosted backend that runs the current tree's functions. The backend
 * decides every outcome; this only observes them, so the orchestrator can wait
 * on events instead of polling the database.
 *
 * What it records:
 *   - each MTA webhook and the backend's answer; a terminal one the backend
 *     acknowledged emits `mta.terminal:<messageId>`;
 *   - each `ingestExternalRaw` call and the backend's outcome for it;
 *   - the end of the backfill (`completeBackfillImport` / `markImportFailed`).
 *
 * A hold rule forwards one ingest, waits until the backend has committed it,
 * and then never answers the worker: the worker dies holding a message the
 * server already stored, inside a batch whose cursor has not advanced. That is
 * the worst case for both duplicates and losses.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { EventLog } from './events';
import { isRecord } from './wire';

/** MTA webhook events after which Convex holds the Send in a terminal state. */
const TERMINAL_WEBHOOK_EVENTS = new Set(['sent', 'bounced', 'failed']);
/** Hop-by-hop or recomputed headers; everything else passes through unchanged. */
const DROPPED_REQUEST_HEADERS = new Set(['host', 'connection', 'content-length', 'keep-alive']);
const DROPPED_RESPONSE_HEADERS = new Set([
	'connection',
	'content-length',
	'content-encoding',
	'keep-alive',
	'transfer-encoding',
]);

export interface MtaWebhookObservation {
	readonly event: string;
	readonly messageId: string;
	readonly backendStatus: number;
}

export interface IngestObservation {
	readonly messageId: string;
	readonly remoteUid: number;
	/** The backend's answer: a new row, a dedup hit, or anything else it said. */
	readonly outcome: 'stored' | 'duplicate' | 'other';
	/** True for the call the worker was killed holding. */
	readonly held: boolean;
}

interface Forwarded {
	readonly status: number;
	readonly headers: Headers;
	readonly body: Buffer;
}

/** What a stalled request resolves to: the proxy never answers it. */
const NEVER = new Promise<never>(() => {});

/**
 * The forwarded bytes as an object. The proxy only observes: a body that is not
 * a JSON object has already gone to the backend as it was, and reads as empty.
 */
function bodyFields(body: Buffer): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(body.toString());
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function functionName(body: Buffer): string {
	const { path } = bodyFields(body);
	return typeof path === 'string' ? path.replace(/\.js(?=:)/, '') : '';
}

function firstArg(body: Buffer): Record<string, unknown> {
	const { args } = bodyFields(body);
	const first: unknown = Array.isArray(args) ? args[0] : args;
	return isRecord(first) ? first : {};
}

/** The `value` of a successful Convex HTTP API answer, or undefined. */
function successValue(response: Forwarded): unknown {
	const answer = bodyFields(response.body);
	return answer['status'] === 'success' ? answer['value'] : undefined;
}

function ingestOutcome(value: unknown): IngestObservation['outcome'] {
	if (!isRecord(value)) return 'other';
	if (value['skipped'] === 'duplicate') return 'duplicate';
	return typeof value['messageId'] === 'string' ? 'stored' : 'other';
}

export class ConvexProxy {
	readonly webhooks: MtaWebhookObservation[] = [];
	readonly ingestCalls: IngestObservation[] = [];
	private holdUids = new Set<number>();

	constructor(
		private readonly events: EventLog,
		/** Backend origin per listening port, e.g. 3211 -> http://backend:3211. */
		private readonly upstreams: ReadonlyMap<number, string>
	) {}

	holdIngest(uids: readonly number[]): void {
		for (const uid of uids) this.holdUids.add(uid);
	}

	async handle(
		port: number,
		request: IncomingMessage,
		body: Buffer,
		response: ServerResponse
	): Promise<void> {
		const path = request.url ?? '/';
		const forwarded = await this.forward(port, request, body);
		const answer = () => {
			const headers: Record<string, string> = {};
			for (const [key, value] of forwarded.headers) {
				if (!DROPPED_RESPONSE_HEADERS.has(key)) headers[key] = value;
			}
			response.writeHead(forwarded.status, headers);
			response.end(forwarded.body);
		};

		if (request.method === 'POST' && new URL(path, 'http://proxy').pathname === '/webhooks/mta') {
			this.observeWebhook(body, forwarded.status);
			return answer();
		}
		if (request.method === 'POST' && /^\/api\/(query|mutation|action)$/.test(path)) {
			const name = functionName(body);
			if (name === 'mail/external/delivery:ingestExternalRaw') {
				if (this.observeIngest(body, forwarded)) return NEVER;
			} else if (name === 'mail/migrationBackfill:completeBackfillImport') {
				this.events.emit('convex.backfill.complete', { status: forwarded.status });
			} else if (name === 'mail/migrationBackfill:markImportFailed') {
				this.events.emit('convex.backfill.failed', firstArg(body));
			}
		}
		return answer();
	}

	private async forward(port: number, request: IncomingMessage, body: Buffer): Promise<Forwarded> {
		const upstream = this.upstreams.get(port);
		if (!upstream) throw new Error(`no upstream for port ${port}`);
		const headers = new Headers();
		for (const [key, value] of Object.entries(request.headers)) {
			if (value === undefined || DROPPED_REQUEST_HEADERS.has(key)) continue;
			headers.set(key, Array.isArray(value) ? value.join(', ') : value);
		}
		const method = request.method ?? 'GET';
		const reply = await fetch(`${upstream}${request.url ?? '/'}`, {
			method,
			headers,
			...(method === 'GET' || method === 'HEAD' ? {} : { body: new Uint8Array(body) }),
			redirect: 'manual',
		});
		return {
			status: reply.status,
			headers: reply.headers,
			body: Buffer.from(await reply.arrayBuffer()),
		};
	}

	private observeWebhook(body: Buffer, backendStatus: number): void {
		const webhook = bodyFields(body);
		const observation = {
			event: typeof webhook['event'] === 'string' ? webhook['event'] : '',
			messageId: typeof webhook['messageId'] === 'string' ? webhook['messageId'] : '',
			backendStatus,
		};
		this.webhooks.push(observation);
		this.events.emit(`mta.webhook:${observation.messageId}:${observation.event}`, observation);
		// Only an acknowledged terminal event counts: on any other answer the
		// MTA's outbox keeps the event and retries it.
		if (
			backendStatus >= 200 &&
			backendStatus < 300 &&
			TERMINAL_WEBHOOK_EVENTS.has(observation.event)
		) {
			this.events.emit(`mta.terminal:${observation.messageId}`, observation);
		}
	}

	/** Records the call; true when this is the held one and must never be answered. */
	private observeIngest(body: Buffer, forwarded: Forwarded): boolean {
		const args = firstArg(body);
		const remoteUid = Number(args['remoteUid']);
		const outcome = ingestOutcome(successValue(forwarded));
		// Only a call the backend actually committed can pin the kill.
		const held = outcome === 'stored' && this.holdUids.delete(remoteUid);
		const observation = { messageId: String(args['messageId']), remoteUid, outcome, held };
		this.ingestCalls.push(observation);
		this.events.emit(`convex.ingest:${remoteUid}`, observation);
		if (held) this.events.emit(`convex.ingest.held:${remoteUid}`, observation);
		return held;
	}
}
