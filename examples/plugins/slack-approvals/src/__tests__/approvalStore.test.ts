import { describe, expect, it } from 'vitest';
import {
	approvalCount,
	createApprovalRequest,
	evaluateApproval,
	hasRejection,
	recordVote,
	type ApprovalRequest,
} from '../approvalStore';

const BASE_MS = 1_700_000_000_000;
const TTL_MS = 60_000;

function newRequest(requiredApprovals: number): ApprovalRequest {
	return createApprovalRequest({
		id: 'msg-1',
		organizationId: 'org-a',
		requiredApprovals,
		createdAtMs: BASE_MS,
		ttlMs: TTL_MS,
	});
}

function approve(
	request: ApprovalRequest,
	voterId: string,
	castAtMs = BASE_MS + 1
): ApprovalRequest {
	const result = recordVote(request, { voterId, vote: 'approve', castAtMs });
	expect(result.accepted).toBe(true);
	return result.request;
}

describe('createApprovalRequest', () => {
	it('rejects a non-positive quorum so a hold can never need zero approvals', () => {
		expect(() =>
			createApprovalRequest({
				id: 'm',
				organizationId: 'o',
				requiredApprovals: 0,
				createdAtMs: BASE_MS,
				ttlMs: TTL_MS,
			})
		).toThrow(RangeError);
	});

	it('rejects a non-positive TTL so a hold can never open already-expired', () => {
		expect(() =>
			createApprovalRequest({
				id: 'm',
				organizationId: 'o',
				requiredApprovals: 1,
				createdAtMs: BASE_MS,
				ttlMs: 0,
			})
		).toThrow(RangeError);
	});

	it('derives expiry from created + ttl and starts pending', () => {
		const request = newRequest(1);
		expect(request.expiresAtMs).toBe(BASE_MS + TTL_MS);
		expect(evaluateApproval(request, BASE_MS)).toBe('pending');
	});
});

describe('quorum', () => {
	it('stays pending below quorum and approves at quorum', () => {
		let request = newRequest(2);
		request = approve(request, 'U1');
		expect(evaluateApproval(request, BASE_MS + 2)).toBe('pending');
		request = approve(request, 'U2');
		expect(approvalCount(request)).toBe(2);
		expect(evaluateApproval(request, BASE_MS + 2)).toBe('approved');
	});

	it('remains approved even after the window would otherwise have closed', () => {
		let request = newRequest(1);
		request = approve(request, 'U1');
		// Re-evaluated long after expiry: quorum reached in-window is terminal.
		expect(evaluateApproval(request, BASE_MS + TTL_MS + 999_999)).toBe('approved');
	});
});

describe('duplicate votes', () => {
	it('counts a repeat approval from the same voter only once', () => {
		let request = newRequest(2);
		request = approve(request, 'U1', BASE_MS + 1);
		request = approve(request, 'U1', BASE_MS + 2);
		request = approve(request, 'U1', BASE_MS + 3);
		expect(approvalCount(request)).toBe(1);
		expect(evaluateApproval(request, BASE_MS + 4)).toBe('pending');
	});

	it('lets a voter change their mind, replacing the prior vote', () => {
		let request = newRequest(1);
		request = approve(request, 'U1', BASE_MS + 1);
		expect(evaluateApproval(request, BASE_MS + 2)).toBe('approved');
		const changed = recordVote(request, { voterId: 'U1', vote: 'reject', castAtMs: BASE_MS + 3 });
		expect(changed.accepted).toBe(true);
		expect(approvalCount(changed.request)).toBe(0);
		expect(hasRejection(changed.request)).toBe(true);
		expect(evaluateApproval(changed.request, BASE_MS + 4)).toBe('rejected');
	});
});

describe('rejection precedence', () => {
	it('a single reject holds even when quorum approvals also exist', () => {
		let request = newRequest(1);
		request = approve(request, 'U1', BASE_MS + 1);
		const rejected = recordVote(request, { voterId: 'U2', vote: 'reject', castAtMs: BASE_MS + 2 });
		expect(rejected.accepted).toBe(true);
		// Quorum (1 approval) is met, but a human rejection dominates → hold.
		expect(approvalCount(rejected.request)).toBe(1);
		expect(evaluateApproval(rejected.request, BASE_MS + 3)).toBe('rejected');
	});
});

describe('expiration', () => {
	it('refuses a vote cast at/after expiry and lapses to expired', () => {
		const request = newRequest(1);
		const late = recordVote(request, {
			voterId: 'U1',
			vote: 'approve',
			castAtMs: request.expiresAtMs,
		});
		expect(late).toEqual({ accepted: false, reason: 'window_closed', request });
		expect(evaluateApproval(request, request.expiresAtMs)).toBe('expired');
	});

	it('drops a vote from an empty/unauthenticated voter id', () => {
		const request = newRequest(1);
		const anon = recordVote(request, { voterId: '   ', vote: 'approve', castAtMs: BASE_MS + 1 });
		expect(anon).toEqual({ accepted: false, reason: 'unknown_voter', request });
	});
});
