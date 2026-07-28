/**
 * Unresolved-bounce observability (M3AAWG "measure unattributable feedback").
 *
 * Its own module rather than a function inside `dispatcher.ts` so that both
 * negative-signal handlers — the inline `email.bounced` one and the extracted
 * `email.complained` one in `complaintDispatch.ts` — share ONE implementation
 * without the dispatcher having to export anything back to its own handlers.
 */

import type { TransitionOutcome } from '../delivery/sendLifecycle';
import { logWarn } from '../lib/runtimeLog';

/**
 * `transitionByProviderMessageId` returns `{ ok: false, reason:
 * 'send_not_found' }` when a provider message id resolves to no Send row, and
 * the webhook path otherwise acks silently. For a negative-signal event
 * (`email.bounced` / `email.complained`) that silence hides a real failure
 * class: a bounce the MTA attributed (so the worker-side unattributed-bounce
 * counter never fires) but which is lost at the Convex resolve step — e.g. the
 * VERP-token-vs-stored-providerMessageId mismatch (PR-01). Without a signal
 * here those bounces are invisible end-to-end.
 *
 * So: when a negative-signal transition resolves to `send_not_found`, emit a
 * structured `unresolved_bounce` warning carrying the event kind and provider
 * message id. The literal token makes the mismatch observable to log-based
 * metrics/alerts rather than a no-op.
 */
export function recordUnresolvedBounce(
	signal: 'email.bounced' | 'email.complained',
	providerMessageId: string,
	at: number,
	outcome: TransitionOutcome | undefined
): void {
	// Only the specific no-row outcome is a signal; any other shape (success,
	// a different failure reason, or an absent return) is a quiet no-op.
	if (!outcome || outcome.ok || outcome.reason !== 'send_not_found') return;
	logWarn(
		`[Webhook Dispatcher] unresolved_bounce: ${signal} for providerMessageId ` +
			`${providerMessageId} resolved to no Send row (at=${at}). The bounce was ` +
			`attributed at the MTA but lost at Convex resolve — measure-unattributable-feedback.`
	);
}
