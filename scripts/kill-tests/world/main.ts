/**
 * The scripted part of the world around the processes under test, in one
 * long-lived container that is never killed: the SMTP sink the MTA delivers to
 * (port 25), the blocklist resolver it checks its sending address against
 * (5353/udp), and the path from both workers to the real Convex backend
 * (world/convexProxy.ts): port 3210 forwards to the backend's function API and
 * also serves the orchestrator's control API under `/control/`, port 3211
 * forwards to its HTTP actions.
 *
 * Runs under bun with no dependencies beyond the runtime, so the container
 * needs nothing but this directory mounted.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { listenBlocklistDns } from './blocklistDns';
import { ConvexProxy } from './convexProxy';
import { EventLog } from './events';
import { SmtpSink } from './smtpSink';
import { decodeHoldRules, decodeHoldUids, parseWire, WireError } from './wire';

const API_PORT = 3210;
const SITE_PORT = 3211;
const SMTP_PORT = 25;
const DNS_PORT = 5353;
/** Upper bound for one control wait; the orchestrator picks shorter ones. */
const MAX_WAIT_MS = 600_000;

const backend = process.env['KILL_BACKEND_HOST'] ?? 'backend.owlat.test';
const events = new EventLog();
const sink = new SmtpSink(events);
const convex = new ConvexProxy(
	events,
	new Map([
		[API_PORT, `http://${backend}:${API_PORT}`],
		[SITE_PORT, `http://${backend}:${SITE_PORT}`],
	])
);

async function readBody(request: IncomingMessage): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks);
}

function send(response: ServerResponse, status: number, body: unknown): void {
	response.writeHead(status, { 'content-type': 'application/json' });
	response.end(JSON.stringify(body));
}

/**
 * A control request's body, checked by `decode`. A body of the wrong shape is
 * answered 400 and arms nothing; the orchestrator fails on any non-2xx answer.
 */
async function controlBody<T>(
	request: IncomingMessage,
	response: ServerResponse,
	decode: (body: unknown) => T
): Promise<T | undefined> {
	try {
		return decode(parseWire((await readBody(request)).toString(), 'control request'));
	} catch (error) {
		if (!(error instanceof WireError)) throw error;
		send(response, 400, { error: error.message });
		return undefined;
	}
}

async function control(url: URL, request: IncomingMessage, response: ServerResponse) {
	if (url.pathname === '/control/wait') {
		const key = url.searchParams.get('key') ?? '';
		const timeoutMs = Math.min(Number(url.searchParams.get('timeoutMs') ?? 0), MAX_WAIT_MS);
		const abort = new AbortController();
		const timer = setTimeout(() => abort.abort(), timeoutMs);
		request.on('close', () => abort.abort());
		const event = await events.waitFor(key, abort.signal);
		clearTimeout(timer);
		return event ? send(response, 200, event) : send(response, 408, { key });
	}
	if (url.pathname === '/control/smtp/hold') {
		const rules = await controlBody(request, response, decodeHoldRules);
		if (!rules) return;
		sink.arm(rules);
		return send(response, 200, { armed: rules.length });
	}
	if (url.pathname === '/control/convex/hold-ingest') {
		const uids = await controlBody(request, response, decodeHoldUids);
		if (!uids) return;
		convex.holdIngest(uids);
		return send(response, 200, { armed: uids.length });
	}
	if (url.pathname === '/control/state') {
		return send(response, 200, {
			events: events.all(),
			smtp: sink.transactions,
			webhooks: convex.webhooks,
			ingestCalls: convex.ingestCalls,
		});
	}
	send(response, 404, { error: 'unknown control route' });
}

function serve(port: number): void {
	createServer((request, response) => {
		const url = new URL(request.url ?? '/', 'http://world');
		const handled =
			port === API_PORT && url.pathname.startsWith('/control/')
				? control(url, request, response)
				: readBody(request).then((body) => convex.handle(port, request, body, response));
		handled.catch((error: unknown) => {
			events.emit('world.error', String(error));
			if (!response.headersSent) send(response, 502, { error: String(error) });
		});
	}).listen(port, '0.0.0.0');
}

serve(API_PORT);
serve(SITE_PORT);
await sink.listen(SMTP_PORT);
await listenBlocklistDns(DNS_PORT);
console.info(
	`kill-test world ready: proxy ${API_PORT}/${SITE_PORT} -> ${backend}, smtp ${SMTP_PORT}, dns ${DNS_PORT}/udp`
);
