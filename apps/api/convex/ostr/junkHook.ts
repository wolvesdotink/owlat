/**
 * The seam between the junk action and observer mode (plan §7.2, §12.2).
 *
 * Lives in the OSTR domain rather than inside `mail/messageActions.ts` for the
 * same reason `cronRegistration.ts` does: the mail domain should say "a message
 * was reported as spam" and nothing about registries, and every rule governing
 * whether that becomes evidence belongs where the rest of them are.
 *
 * It is V8-safe — a mutation cannot import `@owlat/ostr-observer`, which is
 * `node:crypto` all the way down — so all it does is read the operator's opt-in
 * and schedule the Node action that owns the real decision.
 */

import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { isObserverModeEnabled } from './config';

/**
 * Turn one "Report spam" — however many messages it covered — into queued
 * attestation commitments, when the instance is entitled to make them.
 *
 * Fire-and-forget by construction: the user-facing flow is unchanged, and the
 * move must never fail — nor even slow down — because a registry key is
 * missing or a log is unreachable.
 *
 * ONE action for the whole selection, not one per message. Junking two hundred
 * messages is one decision by one person, and the instance-wide eligibility read
 * behind it would otherwise be repeated two hundred times over the same roster.
 *
 * The env check here is only the cheap half of the gate. The §7.4 mailbox floor
 * is checked inside the action, where the decision to PUBLISH is made; a
 * scheduled action that finds the instance ineligible simply returns.
 *
 * The MAILBOX identifies the reporter, never the user id: a mailbox is the unit
 * a distinct-reporter count has to be about, and the action hashes it under a
 * per-instance salt before it is written anywhere.
 *
 * Only a `spam` verdict comes here. "Not spam" is deliberately a no-op in v1: a
 * rescue is a statement about OUR filter, not about the sender, and the spec has
 * no attestation kind meaning "this was fine" — inventing a retraction path
 * would publish a claim nothing can score.
 */
export async function scheduleObserverSpamReports(
	ctx: MutationCtx,
	reports: readonly { messageId: Id<'mailMessages'>; mailboxId: Id<'mailboxes'> }[]
): Promise<void> {
	if (reports.length === 0 || !isObserverModeEnabled()) return;
	await ctx.scheduler.runAfter(0, internal.ostr.observer.captureSpamReports, {
		reports: reports.map((report) => ({
			messageId: report.messageId,
			mailboxId: report.mailboxId,
		})),
	});
}
