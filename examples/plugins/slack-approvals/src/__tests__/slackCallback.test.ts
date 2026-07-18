import { describe, expect, it } from 'vitest';
import { createInMemoryApprovalRepository } from '../approvalRepository';
import { approvalCount, createApprovalRequest, evaluateApproval } from '../approvalStore';
import {
	handleSlackCallback,
	parseSlackInteraction,
	SLACK_APPROVE_ACTION_ID,
	SLACK_REJECT_ACTION_ID,
} from '../slackCallback';
import { signSlackRequest } from '../slackSignature';

const ORG = 'org-a';
const SIGNING_SECRET = 'slack-signing-secret';
const MSG = 'msg-1';
const BASE_MS = 1_700_000_000_000;
const TTL_MS = 60_000;

function interactionBody(voterId: string, actionId: string, requestId: string): string {
	const payload = {
		type: 'block_actions',
		user: { id: voterId },
		actions: [{ action_id: actionId, value: requestId, type: 'button' }],
	};
	return `payload=${encodeURIComponent(JSON.stringify(payload))}`;
}

function seed(requiredApprovals = 1) {
	const repository = createInMemoryApprovalRepository();
	repository.put(
		createApprovalRequest({
			id: MSG,
			organizationId: ORG,
			requiredApprovals,
			createdAtMs: BASE_MS,
			ttlMs: TTL_MS,
		})
	);
	return repository;
}

async function callback(
	repository: ReturnType<typeof createInMemoryApprovalRepository>,
	rawBody: string,
	opts?: { nowMs?: number; signingSecret?: string; badSignature?: boolean }
) {
	const nowMs = opts?.nowMs ?? BASE_MS + 1;
	const ts = Math.floor(nowMs / 1000);
	const signature = opts?.badSignature
		? 'v0=deadbeef'
		: await signSlackRequest(opts?.signingSecret ?? SIGNING_SECRET, ts, rawBody);
	return handleSlackCallback({
		organizationId: ORG,
		signingSecret: SIGNING_SECRET,
		rawBody,
		signatureHeader: signature,
		timestampHeader: String(ts),
		nowMs,
		repository,
	});
}

describe('parseSlackInteraction', () => {
	it('extracts voter, vote, and request id from a block_actions body', () => {
		const parsed = parseSlackInteraction(interactionBody('U1', SLACK_APPROVE_ACTION_ID, MSG));
		expect(parsed).toEqual({ voterId: 'U1', vote: 'approve', requestId: MSG });
	});

	it('returns null for an unrecognised action id', () => {
		expect(parseSlackInteraction(interactionBody('U1', 'owlat_send_now', MSG))).toBeNull();
	});

	it('returns null when more than one action is present (ambiguous)', () => {
		const payload = {
			type: 'block_actions',
			user: { id: 'U1' },
			actions: [
				{ action_id: SLACK_APPROVE_ACTION_ID, value: MSG },
				{ action_id: SLACK_REJECT_ACTION_ID, value: MSG },
			],
		};
		expect(
			parseSlackInteraction(`payload=${encodeURIComponent(JSON.stringify(payload))}`)
		).toBeNull();
	});

	it('returns null for a non-JSON payload', () => {
		expect(parseSlackInteraction('payload=%7Bnot-json')).toBeNull();
	});
});

describe('handleSlackCallback', () => {
	it('records an authenticated approval and reaches quorum', async () => {
		const repository = seed(2);
		const first = await callback(repository, interactionBody('U1', SLACK_APPROVE_ACTION_ID, MSG));
		expect(first).toEqual({ status: 'recorded', vote: 'approve', state: 'pending' });

		const second = await callback(repository, interactionBody('U2', SLACK_APPROVE_ACTION_ID, MSG), {
			nowMs: BASE_MS + 2,
		});
		expect(second).toEqual({ status: 'recorded', vote: 'approve', state: 'approved' });
	});

	it('drops an unauthenticated request and records no vote', async () => {
		const repository = seed(1);
		const result = await callback(repository, interactionBody('U1', SLACK_APPROVE_ACTION_ID, MSG), {
			badSignature: true,
		});
		expect(result).toEqual({ status: 'unauthenticated', reason: 'signature_mismatch' });
		expect(approvalCount(repository.get(ORG, MSG)!)).toBe(0);
	});

	it('drops a signed-but-malformed payload without recording a vote', async () => {
		const repository = seed(1);
		const result = await callback(repository, 'payload=%7Bbroken');
		expect(result).toEqual({ status: 'invalid_payload' });
		expect(approvalCount(repository.get(ORG, MSG)!)).toBe(0);
	});

	it('drops a vote for an unknown request id', async () => {
		const repository = seed(1);
		const result = await callback(
			repository,
			interactionBody('U1', SLACK_APPROVE_ACTION_ID, 'other-msg')
		);
		expect(result).toEqual({ status: 'unknown_request' });
	});

	it('counts a duplicate voter once', async () => {
		const repository = seed(2);
		await callback(repository, interactionBody('U1', SLACK_APPROVE_ACTION_ID, MSG));
		const again = await callback(repository, interactionBody('U1', SLACK_APPROVE_ACTION_ID, MSG), {
			nowMs: BASE_MS + 5,
		});
		expect(again.status).toBe('recorded');
		expect(approvalCount(repository.get(ORG, MSG)!)).toBe(1);
		expect(evaluateApproval(repository.get(ORG, MSG)!, BASE_MS + 6)).toBe('pending');
	});

	it('records a rejection that dominates any approvals', async () => {
		const repository = seed(1);
		const result = await callback(repository, interactionBody('U9', SLACK_REJECT_ACTION_ID, MSG));
		expect(result).toEqual({ status: 'recorded', vote: 'reject', state: 'rejected' });
	});

	it('ignores a vote cast after the window has closed', async () => {
		const repository = seed(1);
		const result = await callback(repository, interactionBody('U1', SLACK_APPROVE_ACTION_ID, MSG), {
			nowMs: BASE_MS + TTL_MS,
		});
		expect(result).toEqual({ status: 'vote_ignored', reason: 'window_closed', state: 'expired' });
	});

	it('isolates tenants: a vote authenticated for org-a cannot touch org-b state', async () => {
		const repository = seed(1);
		const result = await handleSlackCallback({
			organizationId: 'org-b',
			signingSecret: SIGNING_SECRET,
			rawBody: interactionBody('U1', SLACK_APPROVE_ACTION_ID, MSG),
			signatureHeader: await signSlackRequest(
				SIGNING_SECRET,
				Math.floor((BASE_MS + 1) / 1000),
				interactionBody('U1', SLACK_APPROVE_ACTION_ID, MSG)
			),
			timestampHeader: String(Math.floor((BASE_MS + 1) / 1000)),
			nowMs: BASE_MS + 1,
			repository,
		});
		expect(result).toEqual({ status: 'unknown_request' });
		expect(approvalCount(repository.get(ORG, MSG)!)).toBe(0);
	});
});
