import { timingSafeEqual, createHash } from 'node:crypto';
import { Agent, request, type IncomingHttpHeaders } from 'node:http';
import { Readable } from 'node:stream';
import type { H3Event } from 'h3';

/**
 * Shared helpers for the Nuxt server routes that proxy to the updater
 * sidecar (the container that pulls + recreates images on a self-hosted VPS,
 * listening on `http://updater:3200`).
 *
 * Two auth surfaces share these helpers:
 *   - X-Instance-Secret routes (control-plane → VPS): self-update,
 *     configure-ip, and the aggregated health check. They validate the
 *     `X-Instance-Secret` header with `requireInstanceSecret`.
 *   - Session-authed routes (platform-admin UI → VPS): updater-health and
 *     the in-app system update. They authenticate via `requirePlatformAdmin`
 *     and only need the configured secret, via `getInstanceSecret`.
 */

const UPDATER_BASE_URL = 'http://updater:3200';

/**
 * Constant-time string comparison. Hashes both inputs to SHA-256 so the
 * `timingSafeEqual` length precondition always holds (equal-length digests)
 * and the comparison leaks neither length nor content via timing.
 */
function safeCompare(a: string, b: string): boolean {
	const hashA = createHash('sha256').update(a).digest();
	const hashB = createHash('sha256').update(b).digest();
	return timingSafeEqual(hashA, hashB);
}

/**
 * Read `INSTANCE_SECRET` from the environment, throwing a 503 with the given
 * message when it is not configured. The message is route-specific so the
 * client can tell which capability is unavailable.
 */
export function getInstanceSecret(notConfiguredMessage: string): string {
	const instanceSecret = process.env['INSTANCE_SECRET'];
	if (!instanceSecret) {
		throw createError({ statusCode: 503, message: notConfiguredMessage });
	}
	return instanceSecret;
}

/**
 * Validate the incoming `X-Instance-Secret` header against the configured
 * `INSTANCE_SECRET` using a constant-time compare. Throws 503 (with the
 * given message) if the secret is not configured, or 401 if the header is
 * missing or does not match. Returns the configured secret on success so the
 * caller can forward it to the updater.
 */
export function requireInstanceSecret(event: H3Event, notConfiguredMessage: string): string {
	const instanceSecret = getInstanceSecret(notConfiguredMessage);

	const providedSecret = getHeader(event, 'x-instance-secret');
	if (!providedSecret || !safeCompare(providedSecret, instanceSecret)) {
		throw createError({ statusCode: 401, message: 'Unauthorized' });
	}

	return instanceSecret;
}

/** What the updater routes send: a method, JSON headers, a string body and a deadline. */
export interface UpdaterRequestInit {
	method?: string;
	headers?: Record<string, string>;
	body?: string;
	/** The call's only deadline; every caller sets one. */
	signal?: AbortSignal;
}

/**
 * No keep-alive and no socket timeout: nothing but the caller's AbortSignal
 * may end an updater call.
 */
const updaterAgent = new Agent({ keepAlive: false });

// Statuses whose response may not carry a body (`new Response` rejects one).
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

function toHeaders(raw: IncomingHttpHeaders): Headers {
	const headers = new Headers();
	for (const [name, value] of Object.entries(raw)) {
		if (value === undefined) continue;
		for (const one of Array.isArray(value) ? value : [value]) headers.append(name, one);
	}
	return headers;
}

/**
 * Send one request to the updater over `node:http` and hand back a standard
 * `Response` whose body streams from the socket.
 *
 * Not `fetch`: Node's fetch (undici) fails any response whose headers take
 * longer than its `headersTimeout`, five minutes, whatever AbortSignal the
 * caller passes. The updater answers `/update` (in-app and self-update) and
 * `/apply-profiles` only once the rollout and its readiness wait are over,
 * which the routes allow 30 and 10 minutes for, so a slow but healthy update
 * was reported as failed at the five-minute mark. `node:http` has no such
 * deadline, and the caller's signal bounds the whole call instead.
 */
export function requestUpdater(
	url: URL,
	instanceSecret: string,
	init: UpdaterRequestInit = {}
): Promise<Response> {
	const method = init.method ?? 'GET';
	return new Promise<Response>((resolve, reject) => {
		const req = request(
			url,
			{
				method,
				headers: {
					...init.headers,
					'X-Instance-Secret': instanceSecret,
					...(init.body === undefined
						? {}
						: { 'Content-Length': String(Buffer.byteLength(init.body)) }),
				},
				agent: updaterAgent,
				signal: init.signal,
			},
			(res) => {
				try {
					const status = res.statusCode ?? 502;
					const hasBody = method !== 'HEAD' && !NULL_BODY_STATUSES.has(status);
					if (!hasBody) res.resume();
					resolve(
						new Response(
							// node:stream's web-stream type, not the DOM one `Response` names.
							hasBody ? (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>) : null,
							{
								status,
								statusText: res.statusMessage,
								headers: toHeaders(res.headers),
							}
						)
					);
				} catch (err) {
					res.destroy();
					reject(err);
				}
			}
		);
		// Like fetch, reject with the signal's reason (a TimeoutError for
		// `AbortSignal.timeout`), so callers see the same error as before.
		req.on('error', (err) => reject(init.signal?.aborted ? init.signal.reason : err));
		req.end(init.body);
	});
}

/**
 * Call a path on the updater sidecar, injecting the `X-Instance-Secret`
 * header. The caller owns method, body, deadline and response handling. The
 * path must include a leading slash.
 */
export function callUpdater(
	path: string,
	instanceSecret: string,
	init: UpdaterRequestInit = {}
): Promise<Response> {
	return requestUpdater(new URL(path, UPDATER_BASE_URL), instanceSecret, init);
}
