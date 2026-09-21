/**
 * The Convex function-allowlist proxy's request handler.
 *
 * Flow for every request the code-worker makes:
 *   1. Accept only `POST` to one of the three Convex query/mutation/action
 *      endpoints (`ALLOWED_ENDPOINTS`); anything else is 404.
 *   2. Authenticate the WORKER by constant-time comparing the token it presents
 *      in `Authorization: Convex <token>` against `CODE_WORKER_PROXY_TOKEN`.
 *      A missing or wrong token is 401 — the request never reaches Convex.
 *   3. Read the body's Convex function `path` and reject (403) anything not in
 *      `ALLOWED_FUNCTION_PATHS`, before contacting the backend.
 *   4. STRIP the worker token and INJECT the real `CONVEX_ADMIN_KEY` as
 *      `Authorization: Convex <adminKey>`, then forward the byte-identical body
 *      to the real deployment and relay its response back.
 *
 * The worker container therefore never holds the deployment admin key: it holds
 * only the proxy token, which is useless for anything but these thirteen calls.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
	extractConvexToken,
	isAllowedEndpoint,
	isAllowedFunctionPath,
	readFunctionPath,
	safeTokenEqual,
} from './allowlist.js';

/** Resolved, validated runtime configuration for the proxy. */
export interface ProxyConfig {
	/** Base URL of the REAL Convex deployment, e.g. `http://convex:3210`. */
	readonly convexUrl: string;
	/** The deployment admin key the proxy injects on forwarded requests. */
	readonly adminKey: string;
	/** The shared token the worker must present (constant-time compared). */
	readonly workerToken: string;
}

/** Cap the forwarded body so a compromised worker cannot stream an unbounded request. */
const MAX_BODY_BYTES = 5 * 1024 * 1024;

/**
 * Read the raw request body as a string, rejecting once it exceeds
 * `MAX_BODY_BYTES` so an oversized request is dropped rather than buffered.
 */
function readBody(req: IncomingMessage): Promise<string | null> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let total = 0;
		req.on('data', (chunk: Buffer) => {
			total += chunk.length;
			if (total > MAX_BODY_BYTES) {
				resolve(null);
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		req.on('error', reject);
	});
}

function json(res: ServerResponse, status: number, body: unknown): void {
	if (res.headersSent) return;
	res.writeHead(status, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(body));
}

/**
 * Build the HTTP request listener, given resolved config and (for tests) an
 * injectable `fetch`. Exported separately from the listening socket so tests can
 * mount it on an ephemeral server and point `convexUrl` at a mock upstream.
 */
export function createProxyHandler(
	config: ProxyConfig,
	fetchImpl: typeof fetch = fetch
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
	const base = config.convexUrl.replace(/\/+$/, '');

	return async (req: IncomingMessage, res: ServerResponse) => {
		const pathname = new URL(req.url ?? '/', 'http://proxy.internal').pathname;

		// 1. Only POST to a known Convex query/mutation/action endpoint.
		if (req.method !== 'POST' || !isAllowedEndpoint(pathname)) {
			return json(res, 404, { error: 'Not found' });
		}

		// 2. Authenticate the worker; a bad/absent token never reaches Convex.
		const presented = extractConvexToken(req.headers['authorization']);
		if (presented === null || !safeTokenEqual(presented, config.workerToken)) {
			return json(res, 401, { error: 'Unauthorized' });
		}

		const rawBody = await readBody(req);
		if (rawBody === null) {
			return json(res, 413, { error: 'Request body too large' });
		}

		// 3. Allowlist the Convex function path BEFORE contacting the backend.
		const parsed = readFunctionPath(rawBody);
		if (!parsed.ok) {
			return json(res, 400, { error: 'Malformed Convex request body' });
		}
		if (!isAllowedFunctionPath(parsed.path)) {
			return json(res, 403, { error: 'Function not allowed' });
		}

		// 4. Strip the worker token, inject the real admin key, forward verbatim.
		const clientHeader = req.headers['convex-client'];
		const upstreamHeaders: Record<string, string> = {
			'Content-Type': 'application/json',
			Authorization: `Convex ${config.adminKey}`,
		};
		if (typeof clientHeader === 'string') {
			upstreamHeaders['Convex-Client'] = clientHeader;
		}

		let upstream: Response;
		try {
			upstream = await fetchImpl(`${base}${pathname}`, {
				method: 'POST',
				headers: upstreamHeaders,
				body: rawBody,
			});
		} catch {
			return json(res, 502, { error: 'Upstream Convex request failed' });
		}

		const text = await upstream.text();
		const contentType = upstream.headers.get('content-type') ?? 'application/json';
		if (!res.headersSent) {
			res.writeHead(upstream.status, { 'Content-Type': contentType });
			res.end(text);
		}
	};
}

/**
 * Resolve the proxy's configuration from the environment, failing CLOSED: the
 * proxy will not start without an upstream URL, the admin key it injects, and
 * the worker token it validates.
 */
export function resolveConfig(env: NodeJS.ProcessEnv = process.env): ProxyConfig {
	const convexUrl = env['CONVEX_URL']?.trim();
	const adminKey = env['CONVEX_ADMIN_KEY']?.trim();
	const workerToken = env['CODE_WORKER_PROXY_TOKEN']?.trim();
	if (!convexUrl) throw new Error('CONVEX_URL environment variable is required');
	if (!adminKey) throw new Error('CONVEX_ADMIN_KEY environment variable is required');
	if (!workerToken) {
		throw new Error('CODE_WORKER_PROXY_TOKEN environment variable is required');
	}
	return { convexUrl, adminKey, workerToken };
}

/** Port the proxy listens on. */
export const PORT = parseInt(process.env['PROXY_PORT'] || '3220', 10);
