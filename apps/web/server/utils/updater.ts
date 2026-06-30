import { timingSafeEqual, createHash } from 'node:crypto';
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

/**
 * Fetch a path on the updater sidecar, injecting the `X-Instance-Secret`
 * header. Thin passthrough over `fetch` — the caller owns method, body,
 * timeout, and response handling. The path must include a leading slash.
 */
export function callUpdater(
	path: string,
	instanceSecret: string,
	init: RequestInit = {},
): Promise<Response> {
	const headers = new Headers(init.headers);
	headers.set('X-Instance-Secret', instanceSecret);
	return fetch(`${UPDATER_BASE_URL}${path}`, { ...init, headers });
}
