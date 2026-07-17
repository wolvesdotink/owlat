'use node';

/**
 * The SSRF-guarded HTTP transport for Tier-2 signed synchronous hooks.
 *
 * The host engine (`@owlat/plugin-host`) owns signing, response verification,
 * scrubbing, and the fallback decision. This module owns only the wire, and it
 * is the sole place a hook call touches the network:
 *
 *   - validate the destination against the private/internal blocklist and
 *     re-validate at connect time (DNS-rebinding defense) via `guardedDispatcher`;
 *   - refuse any 3xx redirect (redirect-to-internal bypass);
 *   - enforce the per-call wall-clock deadline;
 *   - cap the response body at the engine's byte limit.
 *
 * Every failure is mapped to a typed reason the engine turns into the kind's
 * declared safe fallback — a gate failure becomes an objection, never approval.
 */

import type { SyncHookTransport, SyncHookTransportOutcome } from '@owlat/plugin-host';
import {
	CappedReadOverflow,
	guardedDispatcher,
	readCappedBytes,
	validatePublicUrl,
} from '../../lib/ssrfGuard';

function classifyError(error: unknown): {
	reason: 'timeout' | 'blocked' | 'network';
	message: string;
} {
	const err = error instanceof Error ? error : new Error('network error');
	if (err.name === 'TimeoutError' || err.name === 'AbortError') {
		return { reason: 'timeout', message: 'hook deadline exceeded' };
	}
	if (/disallowed|private\/internal|Blocked connect/i.test(err.message)) {
		return { reason: 'blocked', message: err.message };
	}
	return { reason: 'network', message: err.message };
}

/** Perform one signed hook request under full SSRF protection. */
export const nodeSyncHookTransport: SyncHookTransport = async (
	request
): Promise<SyncHookTransportOutcome> => {
	const validated = await validatePublicUrl(request.url);
	if (!validated.ok) {
		return { ok: false, reason: 'blocked', error: validated.error };
	}

	let response: Response;
	try {
		response = await fetch(request.url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json',
				'User-Agent': 'Owlat-Hooks/1.0',
				...request.headers,
			},
			body: request.body,
			redirect: 'manual',
			signal: AbortSignal.timeout(request.deadlineMs),
			// @ts-expect-error `dispatcher` is an undici-specific fetch option not in
			// the DOM RequestInit lib types, but valid in the Node action runtime.
			dispatcher: guardedDispatcher(),
		});
	} catch (error) {
		const { reason, message } = classifyError(error);
		return { ok: false, reason, error: message };
	}

	// Refuse redirects: an attacker-controlled public host could 30x to an
	// internal target, defeating the up-front and connect-time checks.
	if (response.status >= 300 && response.status < 400) {
		return {
			ok: false,
			reason: 'redirect',
			error: `refusing to follow redirect to ${response.headers.get('location') ?? 'unknown'}`,
		};
	}

	let bytes: Uint8Array | null;
	try {
		bytes = await readCappedBytes(response.body, request.maxResponseBytes);
	} catch (error) {
		if (error instanceof CappedReadOverflow) {
			return { ok: false, reason: 'too-large', error: 'hook response exceeds size limit' };
		}
		const { reason, message } = classifyError(error);
		return { ok: false, reason, error: message };
	}

	const responseHeaders: Record<string, string> = {};
	response.headers.forEach((value, key) => {
		responseHeaders[key.toLowerCase()] = value;
	});

	return {
		ok: true,
		status: response.status,
		headers: responseHeaders,
		body: bytes ? new TextDecoder().decode(bytes) : '',
	};
};
