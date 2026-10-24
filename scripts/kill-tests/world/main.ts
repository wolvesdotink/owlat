/**
 * Everything outside the process under test, in one long-lived container that
 * is never killed: the SMTP sink the MTA delivers to (port 25), the blocklist
 * resolver it checks its sending address against (5353/udp), and one HTTP
 * server (port 3210) that is both the Convex deployment (MTA webhooks, the
 * mail-sync function API and raw upload) and the orchestrator's control API.
 *
 * Runs under bun with no dependencies beyond the runtime, so the container
 * needs nothing but this directory mounted.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { listenBlocklistDns } from './blocklistDns';
import { ConvexStub } from './convexStub';
import { EventLog } from './events';
import { SmtpSink, type HoldRule } from './smtpSink';

const HTTP_PORT = 3210;
const SMTP_PORT = 25;
const DNS_PORT = 5353;
/** Upper bound for one control wait; the orchestrator picks shorter ones. */
const MAX_WAIT_MS = 600_000;

export interface MtaWebhook {
	readonly event: string;
	readonly messageId: string;
	readonly body: Record<string, unknown>;
}

const events = new EventLog();
const sink = new SmtpSink(events);
const convex = new ConvexStub(events, {
	host: process.env['KILL_IMAP_HOST'] ?? 'imap.owlat.test',
	port: Number(process.env['KILL_IMAP_PORT'] ?? 143),
	username: process.env['KILL_IMAP_USER'] ?? 'migrate@owlat.test',
	password: process.env['KILL_IMAP_PASSWORD'] ?? 'pass',
});
const webhooks: MtaWebhook[] = [];

async function readBody(request: IncomingMessage): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks);
}

function send(response: ServerResponse, status: number, body: unknown): void {
	response.writeHead(status, { 'content-type': 'application/json' });
	response.end(JSON.stringify(body));
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
		const { rules } = JSON.parse((await readBody(request)).toString()) as { rules: HoldRule[] };
		sink.arm(rules);
		return send(response, 200, { armed: rules.length });
	}
	if (url.pathname === '/control/convex/import') {
		const { holdUids } = JSON.parse((await readBody(request)).toString()) as {
			holdUids: number[];
		};
		convex.startImport(holdUids);
		return send(response, 200, { importing: true });
	}
	if (url.pathname === '/control/state') {
		return send(response, 200, {
			events: events.all(),
			smtp: sink.transactions,
			webhooks,
			convex: {
				migrationStatus: convex.migrationStatus,
				inboxCursor: convex.cursorOf('INBOX') ?? null,
				stored: [...convex.stored.values()],
				ingestCalls: convex.ingestCalls,
				progress: convex.progress,
			},
		});
	}
	send(response, 404, { error: 'unknown control route' });
}

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
	const url = new URL(request.url ?? '/', 'http://world');
	if (url.pathname.startsWith('/control/')) return control(url, request, response);
	if (request.method !== 'POST') return send(response, 405, { error: 'POST only' });
	const body = await readBody(request);
	if (url.pathname.startsWith('/webhooks/mta')) {
		const parsed = JSON.parse(body.toString()) as Record<string, unknown>;
		const webhook = {
			event: String(parsed['event']),
			messageId: String(parsed['messageId'] ?? ''),
			body: parsed,
		};
		webhooks.push(webhook);
		events.emit(`mta.webhook:${webhook.messageId}:${webhook.event}`, parsed);
		// The events after which Convex holds the Send in a terminal state
		// (oracle.ts TERMINAL_EVENTS; this container imports nothing from the repo).
		if (['sent', 'bounced', 'failed'].includes(webhook.event)) {
			events.emit(`mta.terminal:${webhook.messageId}`, parsed);
		}
		return send(response, 200, { ok: true });
	}
	if (url.pathname === '/http/mail-sync/raw-message') {
		return send(response, 200, convex.upload(body.length));
	}
	if (/^\/api\/(query|mutation|action)$/.test(url.pathname)) {
		const answer = await convex.call(url.pathname, JSON.parse(body.toString()));
		return send(response, 200, answer);
	}
	send(response, 404, { error: `no route ${url.pathname}` });
}

createServer((request, response) => {
	route(request, response).catch((error: unknown) => {
		events.emit('world.error', String(error));
		if (!response.headersSent) send(response, 500, { error: String(error) });
	});
}).listen(HTTP_PORT, '0.0.0.0');
await sink.listen(SMTP_PORT);
await listenBlocklistDns(DNS_PORT);
console.info(`kill-test world ready: http ${HTTP_PORT}, smtp ${SMTP_PORT}, dns ${DNS_PORT}/udp`);
