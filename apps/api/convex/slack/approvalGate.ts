/**
 * Slack approvals reference app — restrict-only hold gate (Tier-2 connected app,
 * PP-26). Wired as the FINAL stage of the autonomous-send gate chain, after
 * every immutable core gate and every hosted plugin gate, so it can only ever
 * further RESTRICT a send that already survived them. It can never override a
 * core hold: if any earlier gate held, this gate never runs.
 *
 * Behavior:
 *   - app inactive (secret or webhook unset) → SAFE, holds nothing, zero DB work
 *     (feature-off parity with a deployment that never configured Slack);
 *   - app active, no quorum-approved unexpired record → HOLD, and (once) create
 *     the record + notify Slack;
 *   - app active, quorum-approved unexpired record → SAFE (release its OWN hold,
 *     returning to the baseline the send would have taken without this app);
 *   - any error → HOLD (fail closed toward human review, never toward sending).
 *
 * Slack can only reach this gate through {@link runSlackApprovalHoldGate}'s
 * `ensureHold` mutation, which records votes and reports release/hold. Slack has
 * no path to send, to approve the message, or to skip an earlier gate.
 */

import type { Id } from '../_generated/dataModel';
import type { ActionCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import { readSlackApprovalsConfig } from './config';

export type SlackApprovalGateDecision =
	| { readonly safe: true }
	| { readonly safe: false; readonly reason: string };

const HOLD_REASON =
	'Held for Slack approval — awaiting quorum in Slack; not auto-sending. Routing to human review.';
const UNAVAILABLE_REASON =
	'Could not evaluate the Slack approval hold; not auto-sending — routing to human review.';

/**
 * Evaluate the Slack approval hold for a message. Returns `{ safe: true }` when
 * the app is inactive or the request is quorum-approved; otherwise holds. Never
 * throws — an unexpected failure resolves to a hold.
 */
export async function runSlackApprovalHoldGate(
	action: ActionCtx,
	inboundMessageId: Id<'inboundMessages'>
): Promise<SlackApprovalGateDecision> {
	const config = readSlackApprovalsConfig();
	// Inactive app is inert — no DB access, identical to pre-app behavior.
	if (!config.active) return Object.freeze({ safe: true });

	try {
		const decision = await action.runMutation(internal.slack.approvals.ensureHold, {
			inboundMessageId,
			quorum: config.quorum,
			ttlMs: config.ttlMs,
		});
		return decision.release
			? Object.freeze({ safe: true })
			: Object.freeze({ safe: false, reason: HOLD_REASON });
	} catch {
		// Fail closed: a Slack/DB error holds the send, never releases it.
		return Object.freeze({ safe: false, reason: UNAVAILABLE_REASON });
	}
}
