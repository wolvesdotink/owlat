'use node';

/**
 * RFC 8058 One-Click unsubscribe for Postbox list mail.
 *
 * Every person-facing unsubscribe (the reader's chip, ⇧O, the Senders page,
 * the Subscriptions panel) reaches this POST through
 * `mail/senders/unsubscribeActions.ts`, after an explicit user confirmation;
 * the POST happens server-side (the sender's endpoint
 * never sees the user's browser/IP context, and the request works even when
 * the endpoint lacks CORS). The target URL comes from an attacker-controlled
 * mail header. The shared URL policy requires https without credentials or
 * literal/local hosts; fetchGuarded additionally validates DNS answers before
 * the request and at socket connection time to prevent DNS rebinding.
 *
 * Fail-soft: network errors, timeouts, and non-2xx responses come back as
 * `{ ok: false }` for a toast — never a thrown error, and nothing about the
 * message is modified either way.
 */

import { v } from 'convex/values';
import { isSafeUnsubscribeUrl } from '@owlat/shared/listUnsubscribe';
import { api, internal } from '../_generated/api';
import { authedAction } from '../lib/authedFunctions';
import type { UnsubscribeOutcome } from './senders/unsubscribeActions';
import { fetchGuarded, SsrfBlockedError } from '../lib/ssrfGuard';

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
	fetchImpl: (url: string, init: RequestInit) => Promise<Response> = fetchGuarded
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
		// Only the status matters; do not retain an untrusted response stream.
		void res.body?.cancel().catch(() => undefined);
		if (res.ok) return { ok: true };
		return { ok: false, error: `http_${res.status}` };
	} catch (error) {
		return { ok: false, error: error instanceof SsrfBlockedError ? 'unsafe_url' : 'network' };
	}
}

/**
 * ONE-RELEASE COMPATIBILITY SHIM (`scripts/entryWiringPreviousRelease.ts`):
 * the previous Unsubscribe chip, in shipped desktop bundles and tabs opened
 * before the deploy, still calls this path. It delegates to the one
 * unsubscribe path (`api.mail.senders.unsubscribeActions.unsubscribe`, so
 * personal mail is also suppressed locally and the result recorded) and
 * answers in the old `{ ok, error? }` shape. A message without a one-click
 * target answers `not_one_click` with nothing changed, as it always did.
 * Delete with its ledger line in the next release.
 */
// authz: org membership via authedAction; mailbox access in the delegated
// flow (startUnsubscribe: requireMailboxAccess on the propagated session).
export const performOneClick = authedAction({
	args: { messageId: v.id('mailMessages') },
	handler: async (ctx, args): Promise<OneClickResult> => {
		const target = await ctx.runQuery(internal.mail.senders.unsubscribe.oneClickTarget, {
			messageId: args.messageId,
		});
		if (!target) return { ok: false, error: 'not_one_click' };
		const outcome: UnsubscribeOutcome = await ctx.runAction(
			api.mail.senders.unsubscribeActions.unsubscribe,
			{ target: { messageId: args.messageId } }
		);
		if (outcome.result === 'confirmed') return { ok: true };
		return { ok: false, error: outcome.error ?? 'not_one_click' };
	},
});
