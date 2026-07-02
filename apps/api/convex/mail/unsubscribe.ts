'use node';

/**
 * RFC 8058 One-Click unsubscribe for Postbox list mail.
 *
 * The reader's Unsubscribe chip calls `performOneClick` after an explicit
 * user confirmation; the POST happens server-side (the sender's endpoint
 * never sees the user's browser/IP context, and the request works even when
 * the endpoint lacks CORS). The target URL comes from an attacker-controlled
 * mail header, so it is re-validated here with the shared SSRF guard
 * (`isSafeUnsubscribeUrl`: https only, no credentials, no IP-literal /
 * local / internal hosts) before any network I/O.
 *
 * Fail-soft: network errors, timeouts, and non-2xx responses come back as
 * `{ ok: false }` for a toast — never a thrown error, and nothing about the
 * message is modified either way.
 */

import { v } from 'convex/values';
import { authedAction } from '../lib/authedFunctions';
import { api } from '../_generated/api';
import { isSafeUnsubscribeUrl } from '@owlat/shared/listUnsubscribe';
import { logError } from '../lib/runtimeLog';
import { throwNotFound } from '../_utils/errors';

/** Bounded wait for the sender's unsubscribe endpoint. */
export const ONE_CLICK_TIMEOUT_MS = 10_000;

export type OneClickResult = { ok: true } | { ok: false; error: string };

/**
 * Perform the RFC 8058 POST (`List-Unsubscribe=One-Click` form body) against
 * a One-Click https URL. Pure (fetch injected) so it unit-tests with a spy,
 * mirroring `delivery.scanInboundAttachments`.
 *
 * Redirects are NOT followed (`redirect: 'manual'`): the SSRF guard vetted
 * only this URL, and RFC 8058 §3.2 expects the endpoint itself to accept the
 * POST. The response body is never surfaced to the caller.
 */
export async function postOneClickUnsubscribe(
	url: string,
	fetchImpl: typeof fetch = fetch,
): Promise<OneClickResult> {
	if (!isSafeUnsubscribeUrl(url)) return { ok: false, error: 'unsafe_url' };
	try {
		const res = await fetchImpl(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: 'List-Unsubscribe=One-Click',
			redirect: 'manual',
			signal: AbortSignal.timeout(ONE_CLICK_TIMEOUT_MS),
		});
		if (res.ok) return { ok: true };
		return { ok: false, error: `http_${res.status}` };
	} catch {
		return { ok: false, error: 'network' };
	}
}

/**
 * One-Click unsubscribe for a received list message. Only ever invoked from
 * an explicit user confirmation in the reader — never on render.
 */
// authz: ownership enforced by mail.mailbox.getMessage (returns null for a
// non-owned message); org membership enforced by authedAction.
export const performOneClick = authedAction({
	args: { messageId: v.id('mailMessages') },
	handler: async (ctx, args): Promise<OneClickResult> => {
		const message = await ctx.runQuery(api.mail.mailbox.getMessage, {
			messageId: args.messageId,
		});
		if (!message) throwNotFound('Message');
		const target = message.unsubscribe;
		if (!target?.oneClick || !target.httpUrl) {
			return { ok: false, error: 'not_one_click' };
		}
		const result = await postOneClickUnsubscribe(target.httpUrl);
		if (!result.ok) {
			// Fail-soft: surfaced to the user as a toast; log for the operator.
			logError('[Postbox unsubscribe] one-click POST failed', result.error);
		}
		return result;
	},
});
