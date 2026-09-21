/**
 * Pure policy for the Convex function-allowlist proxy.
 *
 * The code-worker runs UNTRUSTED, inbound-email-driven code, yet it must reach
 * the Convex backend to poll/claim/complete its task queue. Self-hosted Convex
 * mints only a FULL deployment admin key — there is no per-function scoping — so
 * the least-privilege boundary is built OUTSIDE Convex, here: this sidecar holds
 * the real admin key, and only forwards a request whose Convex function `path`
 * is one of the exact thirteen the worker legitimately calls. Everything else is
 * a 403 that never reaches the backend, so a compromised task cannot use the
 * worker's credential to read or write any other table.
 *
 * This module is deliberately free of HTTP / process side effects so every gate
 * is exercised in isolation by `__tests__/allowlist.test.ts`; `proxy.ts` wires
 * these into the request handler.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * The EXACT set of Convex function paths the code-worker is permitted to call,
 * across the two worker-queue namespaces. Kept in lock-step with the `fn` and
 * `pluginFn` reference tables in `apps/code-worker/src/convexClient.ts`: the
 * worker can call nothing this set omits, and this set names nothing the worker
 * does not call. Any other path — `codeWorkTasks:create`, an admin mutation, a
 * different module — is rejected before it reaches the deployment.
 */
export const ALLOWED_FUNCTION_PATHS: ReadonlySet<string> = new Set([
	// codeWorkTasks (coding-agent queue)
	'codeWorkTasks:getNextQueued',
	'codeWorkTasks:claim',
	'codeWorkTasks:updateBranch',
	'codeWorkTasks:markTesting',
	'codeWorkTasks:completeWithPR',
	'codeWorkTasks:markFailed',
	'codeWorkTasks:reclaimStale',
	// plugins/workerTasks (generalized Tier-3 worker queue)
	'plugins/workerTasks:getNextQueued',
	'plugins/workerTasks:claim',
	'plugins/workerTasks:heartbeat',
	'plugins/workerTasks:complete',
	'plugins/workerTasks:fail',
	'plugins/workerTasks:reclaimStale',
]);

/**
 * The Convex HTTP endpoints the proxy accepts. Verified against the installed
 * client (`node_modules/convex/dist/esm/browser/http_client.js`): a plain
 * `ConvexHttpClient.query()` POSTs `/api/query`, `.mutation()` POSTs
 * `/api/mutation`, and `.action()` POSTs `/api/action`, each with a JSON body
 * `{ path, format: "convex_encoded_json", args }`. Any other path (the
 * un-timestamped surface, `/api/function`, dashboard routes) is refused so the
 * worker's credential reaches nothing but these three query/mutation/action
 * entry points.
 */
export const ALLOWED_ENDPOINTS: ReadonlySet<string> = new Set([
	'/api/query',
	'/api/mutation',
	'/api/action',
]);

/** True when `path` is a Convex function the worker is allowed to invoke. */
export function isAllowedFunctionPath(path: unknown): path is string {
	return typeof path === 'string' && ALLOWED_FUNCTION_PATHS.has(path);
}

/** True when `pathname` is one of the accepted Convex HTTP endpoints. */
export function isAllowedEndpoint(pathname: string): boolean {
	return ALLOWED_ENDPOINTS.has(pathname);
}

/**
 * Extract the bearer token from a Convex `Authorization` header.
 *
 * The worker authenticates via `ConvexHttpClient.setAdminAuth(token)`, which
 * (verified against the installed client) sets `Authorization: Convex <token>`
 * with no `actingAsIdentity` suffix. We return the substring after the single
 * `Convex ` scheme prefix, or `null` when the header is absent or malformed.
 */
export function extractConvexToken(authorization: string | undefined): string | null {
	if (typeof authorization !== 'string') return null;
	const prefix = 'Convex ';
	if (!authorization.startsWith(prefix)) return null;
	const token = authorization.slice(prefix.length);
	return token.length > 0 ? token : null;
}

/**
 * Constant-time comparison of two secrets. Both are SHA-256 hashed first so the
 * lengths always match `timingSafeEqual`'s equal-length requirement and the
 * comparison never leaks length. Mirrors the updater sidecar's `safeCompare`.
 */
export function safeTokenEqual(a: string, b: string): boolean {
	const hashA = createHash('sha256').update(a).digest();
	const hashB = createHash('sha256').update(b).digest();
	return timingSafeEqual(hashA, hashB);
}

/**
 * Parse the incoming request body far enough to read its Convex function `path`.
 * The body is the client's JSON `{ path, format, args }`; anything that is not a
 * JSON object with a string `path` is rejected (the caller returns 400) rather
 * than forwarded, so a malformed body can never slip past the allowlist.
 */
export function readFunctionPath(rawBody: string): { ok: true; path: string } | { ok: false } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawBody);
	} catch {
		return { ok: false };
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		return { ok: false };
	}
	const path = (parsed as { path?: unknown }).path;
	if (typeof path !== 'string' || path.length === 0) {
		return { ok: false };
	}
	return { ok: true, path };
}
