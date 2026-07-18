/**
 * The inbound Slack interaction endpoint: a human clicked Approve or Reject on
 * the pending-draft message this app posted.
 *
 * The order is security-first and every step FAILS CLOSED (no vote recorded):
 *   1. verify the Slack request signature + freshness — an unauthenticated or
 *      replayed request is dropped before it can influence any hold;
 *   2. strictly parse the `application/x-www-form-urlencoded` `payload` JSON into
 *      exactly (voter id, vote, request id) — anything malformed is dropped;
 *   3. load the tenant-scoped request — an unknown id is dropped;
 *   4. record the vote through the pure store (dedup + window rules) and persist.
 *
 * The handler NEVER sends anything and NEVER returns an "approved → send" signal.
 * Its most consequential effect is to move a hold from `pending` to `approved`,
 * which only means the app's gate will stop objecting — Owlat still runs its own
 * gates before anything leaves.
 */

import type { ApprovalRepository } from './approvalRepository';
import { evaluateApproval, recordVote, type ApprovalState, type Vote } from './approvalStore';
import { verifySlackSignature, type SlackSignatureFailure } from './slackSignature';

/** The `action_id`s the posted message's buttons carry. */
export const SLACK_APPROVE_ACTION_ID = 'owlat_approve';
export const SLACK_REJECT_ACTION_ID = 'owlat_reject';

interface ParsedInteraction {
	readonly voterId: string;
	readonly vote: Vote;
	readonly requestId: string;
}

export interface SlackCallbackInput {
	readonly organizationId: string;
	readonly signingSecret: string;
	readonly rawBody: string;
	readonly signatureHeader: string | null | undefined;
	readonly timestampHeader: string | null | undefined;
	readonly nowMs: number;
	readonly repository: ApprovalRepository;
	readonly toleranceSeconds?: number;
}

export type SlackCallbackResult =
	| { readonly status: 'unauthenticated'; readonly reason: SlackSignatureFailure }
	| { readonly status: 'invalid_payload' }
	| { readonly status: 'unknown_request' }
	| { readonly status: 'vote_ignored'; readonly reason: string; readonly state: ApprovalState }
	| { readonly status: 'recorded'; readonly vote: Vote; readonly state: ApprovalState };

function readString(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function voteFromActionId(actionId: string): Vote | null {
	if (actionId === SLACK_APPROVE_ACTION_ID) return 'approve';
	if (actionId === SLACK_REJECT_ACTION_ID) return 'reject';
	return null;
}

/**
 * Strictly parse a Slack `block_actions` interaction body into the three fields
 * a vote needs. Returns `null` on anything unexpected — a wrong content shape, a
 * missing user, no recognised action — so an ambiguous payload is never guessed
 * into a vote.
 */
export function parseSlackInteraction(rawBody: string): ParsedInteraction | null {
	let payloadJson: string | null;
	try {
		payloadJson = new URLSearchParams(rawBody).get('payload');
	} catch {
		return null;
	}
	if (payloadJson === null || payloadJson.length === 0) return null;

	let parsed: unknown;
	try {
		parsed = JSON.parse(payloadJson);
	} catch {
		return null;
	}
	if (!isRecord(parsed)) return null;
	if (parsed['type'] !== 'block_actions') return null;

	const user = parsed['user'];
	if (!isRecord(user)) return null;
	const voterId = readString(user, 'id');
	if (voterId === undefined) return null;

	const actions = parsed['actions'];
	if (!Array.isArray(actions) || actions.length !== 1) return null;
	const action = actions[0];
	if (!isRecord(action)) return null;
	const actionId = readString(action, 'action_id');
	const requestId = readString(action, 'value');
	if (actionId === undefined || requestId === undefined) return null;
	const vote = voteFromActionId(actionId);
	if (vote === null) return null;

	return { voterId, vote, requestId };
}

/** Authenticate, parse, and apply one Slack interaction. Never throws. */
export async function handleSlackCallback(input: SlackCallbackInput): Promise<SlackCallbackResult> {
	const signature = await verifySlackSignature({
		signingSecret: input.signingSecret,
		signatureHeader: input.signatureHeader,
		timestampHeader: input.timestampHeader,
		rawBody: input.rawBody,
		nowMs: input.nowMs,
		...(input.toleranceSeconds === undefined ? {} : { toleranceSeconds: input.toleranceSeconds }),
	});
	if (!signature.valid) {
		return { status: 'unauthenticated', reason: signature.reason };
	}

	const interaction = parseSlackInteraction(input.rawBody);
	if (interaction === null) {
		return { status: 'invalid_payload' };
	}

	const request = input.repository.get(input.organizationId, interaction.requestId);
	if (request === undefined) {
		return { status: 'unknown_request' };
	}

	const outcome = recordVote(request, {
		voterId: interaction.voterId,
		vote: interaction.vote,
		castAtMs: input.nowMs,
	});
	if (!outcome.accepted) {
		return {
			status: 'vote_ignored',
			reason: outcome.reason,
			state: evaluateApproval(outcome.request, input.nowMs),
		};
	}
	input.repository.put(outcome.request);
	return {
		status: 'recorded',
		vote: interaction.vote,
		state: evaluateApproval(outcome.request, input.nowMs),
	};
}
