/**
 * The restrict-only hold gate — what Owlat's `gate` hook actually calls.
 *
 * The contract with Owlat is deliberately narrow: this app answers a gate hook
 * with a `RestrictOnlyGateResult`, and the ONLY two answers that exist are
 * `no-objection` (the app has nothing to add) and `objection` (hold and route to
 * a human). There is no answer that approves, unblocks, or sends — that is a
 * structural property of `RestrictOnlyGateResult`, not a runtime check, so even a
 * fully-compromised Slack workspace cannot turn this hook into a send command.
 *
 * The decision:
 *   - first time Owlat asks about a draft → open an approval request, post it to
 *     Slack (best effort), and OBJECT (hold, awaiting quorum);
 *   - a real human quorum reached inside the window → `no-objection` (the app
 *     stops holding; Owlat's own gates still decide whether to send);
 *   - pending / expired / rejected / an unreadable payload / any thrown error →
 *     OBJECT. The gate fails CLOSED toward holding in every degraded case.
 */

import type { PluginAutonomyGateResult } from '@owlat/plugin-kit';
import type { ApprovalRepository } from './approvalRepository';
import { createApprovalRequest, evaluateApproval } from './approvalStore';
import { readOwnProperty, readOwnString } from './objectAccess';
import type { ApprovalNotifier } from './notify';
import {
	OWLAT_HOOK_HEADERS,
	signOwlatHookResponse,
	verifyOwlatHookRequest,
	type NonceGuard,
	type VerifyHookRequestInput,
} from './hookWire';

/** Operator-tunable gate policy for one connection. */
export interface SlackApprovalsGateConfig {
	readonly requiredApprovals: number;
	readonly ttlMs: number;
}

export interface EvaluateGateInput {
	readonly organizationId: string;
	readonly payload: unknown;
	readonly config: SlackApprovalsGateConfig;
	readonly repository: ApprovalRepository;
	readonly notifier: ApprovalNotifier;
	readonly nowMs: number;
}

/** Fixed, app-authored hold reasons — never Slack- or draft-derived text. */
const HOLD_REASONS = Object.freeze({
	unidentifiable: 'Awaiting Slack approval: the draft could not be identified; holding for review.',
	awaiting: 'Awaiting Slack approval quorum before this reply may auto-send.',
	rejected: 'A reviewer rejected this reply in Slack; holding for human review.',
	expired: 'The Slack approval window expired before quorum; holding for human review.',
	error: 'The Slack approvals gate could not be evaluated; holding for human review.',
});

const NO_GATE_OBJECTION = Object.freeze({
	outcome: 'no-objection',
} as const satisfies PluginAutonomyGateResult);

function createGateObjection(reason: string): PluginAutonomyGateResult {
	return Object.freeze({ outcome: 'objection' as const, reason });
}

/**
 * Decide the gate for one draft. Always resolves to a restrict-only verdict and
 * never throws — an internal fault becomes an objection (hold), so an exception
 * can never be mistaken for approval.
 */
export async function evaluateGate(input: EvaluateGateInput): Promise<PluginAutonomyGateResult> {
	try {
		const messageId = readOwnString(input.payload, 'messageId');
		if (messageId === undefined) {
			return createGateObjection(HOLD_REASONS.unidentifiable);
		}

		const existing = input.repository.get(input.organizationId, messageId);
		if (existing === undefined) {
			await openHold(input, messageId);
			return createGateObjection(HOLD_REASONS.awaiting);
		}

		const state = evaluateApproval(existing, input.nowMs);
		switch (state) {
			case 'approved':
				return NO_GATE_OBJECTION;
			case 'rejected':
				return createGateObjection(HOLD_REASONS.rejected);
			case 'expired':
				return createGateObjection(HOLD_REASONS.expired);
			case 'pending':
				return createGateObjection(HOLD_REASONS.awaiting);
		}
	} catch {
		return createGateObjection(HOLD_REASONS.error);
	}
}

/**
 * Open a new hold and announce it to Slack. Persistence happens first so a
 * failed notification still leaves the draft HELD (the notifier throw is
 * swallowed) — never the other way around.
 */
async function openHold(input: EvaluateGateInput, messageId: string): Promise<void> {
	const request = createApprovalRequest({
		id: messageId,
		organizationId: input.organizationId,
		requiredApprovals: input.config.requiredApprovals,
		createdAtMs: input.nowMs,
		ttlMs: input.config.ttlMs,
	});
	input.repository.put(request);
	try {
		await input.notifier.postApprovalRequest(request, input.payload);
	} catch {
		// Best effort: a Slack outage must not un-hold the draft.
	}
}

export interface ServeGateHookInput {
	readonly connection: {
		readonly organizationId: string;
		readonly connectedAppId: string;
		readonly secret: string;
		readonly config: SlackApprovalsGateConfig;
	};
	readonly headers: VerifyHookRequestInput['headers'];
	readonly rawBody: string;
	readonly nowMs: number;
	readonly repository: ApprovalRepository;
	readonly notifier: ApprovalNotifier;
	readonly nonceGuard?: NonceGuard;
	readonly toleranceSeconds?: number;
}

export interface GateHookHttpResponse {
	readonly status: number;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: string;
}

/**
 * The full HTTP endpoint Owlat's `gate` hook calls: authenticate the signed
 * request, evaluate the gate, and return a SIGNED restrict-only response. An
 * unauthenticated request is refused with 401 and no body Owlat would trust —
 * which Owlat's client maps to its own fail-closed gate objection anyway, so the
 * hold is preserved on both sides.
 */
export async function serveGateHook(input: ServeGateHookInput): Promise<GateHookHttpResponse> {
	const verification = await verifyOwlatHookRequest({
		secret: input.connection.secret,
		expectedAppId: input.connection.connectedAppId,
		headers: input.headers,
		rawBody: input.rawBody,
		nowMs: input.nowMs,
		...(input.nonceGuard === undefined ? {} : { nonceGuard: input.nonceGuard }),
		...(input.toleranceSeconds === undefined ? {} : { toleranceSeconds: input.toleranceSeconds }),
	});
	if (!verification.valid) {
		return { status: 401, headers: Object.freeze({}), body: '' };
	}
	// This app serves ONLY the gate hook. A signed request for another kind is a
	// misconfiguration; refuse it rather than answer off-contract.
	if (verification.request.hookKind !== 'gate') {
		return { status: 400, headers: Object.freeze({}), body: '' };
	}

	let payload: unknown;
	try {
		payload = JSON.parse(input.rawBody);
	} catch {
		payload = {};
	}

	const verdict = await evaluateGate({
		organizationId: input.connection.organizationId,
		payload: extractPayload(payload),
		config: input.connection.config,
		repository: input.repository,
		notifier: input.notifier,
		nowMs: input.nowMs,
	});

	const body = JSON.stringify(verdict);
	const signed = await signOwlatHookResponse({
		secret: input.connection.secret,
		hookKind: 'gate',
		connectedAppId: input.connection.connectedAppId,
		requestNonce: verification.request.nonce,
		responseTimestampSeconds: Math.floor(input.nowMs / 1000),
		body,
	});
	return { status: 200, headers: signed.headers, body: signed.body };
}

/** Owlat wraps the hook payload as `{ ..., payload: {...} }`; unwrap it defensively. */
function extractPayload(envelope: unknown): unknown {
	const payload = readOwnProperty(envelope, 'payload');
	return payload === undefined ? {} : payload;
}

export { OWLAT_HOOK_HEADERS };
