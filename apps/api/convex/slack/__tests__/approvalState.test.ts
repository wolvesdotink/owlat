import { describe, expect, it } from 'vitest';
import {
	countApprovers,
	deriveApprovalStatus,
	effectiveVotes,
	isApproved,
	voteToRecord,
	type SlackApprovalSnapshot,
	type SlackApprovalVote,
} from '../approvalState';

const T0 = 1_000_000;
const EXPIRES = T0 + 60_000;

function snapshot(
	votes: readonly SlackApprovalVote[],
	overrides: Partial<Pick<SlackApprovalSnapshot, 'quorum' | 'expiresAt'>> = {}
): SlackApprovalSnapshot {
	return { quorum: overrides.quorum ?? 2, expiresAt: overrides.expiresAt ?? EXPIRES, votes };
}

const approve = (slackUserId: string, votedAt = T0): SlackApprovalVote => ({
	slackUserId,
	decision: 'approve',
	votedAt,
});
const reject = (slackUserId: string, votedAt = T0): SlackApprovalVote => ({
	slackUserId,
	decision: 'reject',
	votedAt,
});

describe('effectiveVotes — duplicate collapse (first vote wins)', () => {
	it('keeps one vote per Slack user, the first recorded', () => {
		const votes = [approve('U1', T0), approve('U1', T0 + 5), reject('U1', T0 + 9)];
		const effective = effectiveVotes(votes);
		expect(effective).toHaveLength(1);
		expect(effective[0]).toEqual(approve('U1', T0));
	});

	it('a replayed reject cannot flip a recorded approve', () => {
		const votes = [approve('U1'), reject('U1')];
		expect(effectiveVotes(votes)).toEqual([approve('U1')]);
	});
});

describe('voteToRecord — idempotent recording', () => {
	it('returns the vote when the user has not voted', () => {
		expect(voteToRecord([approve('U1')], approve('U2'))).toEqual(approve('U2'));
	});

	it('returns null for a duplicate/replay from an already-voted user', () => {
		expect(voteToRecord([approve('U1')], approve('U1'))).toBeNull();
		expect(voteToRecord([approve('U1')], reject('U1'))).toBeNull();
	});
});

describe('countApprovers — distinct, on-or-before expiry', () => {
	it('counts distinct approvers only', () => {
		expect(countApprovers(snapshot([approve('U1'), approve('U1'), approve('U2')]))).toBe(2);
	});

	it('excludes approve votes cast after expiry', () => {
		expect(countApprovers(snapshot([approve('U1', EXPIRES + 1)]))).toBe(0);
		expect(countApprovers(snapshot([approve('U1', EXPIRES)]))).toBe(1);
	});
});

describe('deriveApprovalStatus — quorum boundary', () => {
	it('is pending one approver short of quorum', () => {
		expect(deriveApprovalStatus(snapshot([approve('U1')], { quorum: 2 }), T0)).toBe('pending');
	});

	it('is approved exactly at quorum', () => {
		expect(deriveApprovalStatus(snapshot([approve('U1'), approve('U2')], { quorum: 2 }), T0)).toBe(
			'approved'
		);
	});

	it('a quorum of 1 approves on the first approve', () => {
		expect(deriveApprovalStatus(snapshot([approve('U1')], { quorum: 1 }), T0)).toBe('approved');
	});
});

describe('deriveApprovalStatus — reject holds (restrict-only)', () => {
	it('any reject holds even past quorum approvals', () => {
		const votes = [approve('U1'), approve('U2'), reject('U3')];
		expect(deriveApprovalStatus(snapshot(votes, { quorum: 2 }), T0)).toBe('rejected');
	});
});

describe('deriveApprovalStatus — expiration fails closed', () => {
	it('expires when quorum is not reached in time', () => {
		expect(deriveApprovalStatus(snapshot([approve('U1')], { quorum: 2 }), EXPIRES)).toBe('expired');
	});

	it('a late approve (after expiry) never counts — stays held/expired', () => {
		const votes = [approve('U1', T0), approve('U2', EXPIRES + 1)];
		expect(deriveApprovalStatus(snapshot(votes, { quorum: 2 }), EXPIRES + 2)).toBe('expired');
	});

	it('quorum reached before expiry stays approved even when read after expiry', () => {
		const votes = [approve('U1', T0), approve('U2', T0)];
		expect(deriveApprovalStatus(snapshot(votes, { quorum: 2 }), EXPIRES + 10_000)).toBe('approved');
	});
});

describe('deriveApprovalStatus — malformed quorum can never release', () => {
	for (const bad of [0, -1, 1.5, Number.NaN]) {
		it(`quorum ${String(bad)} holds regardless of approvals`, () => {
			const votes = [approve('U1'), approve('U2'), approve('U3')];
			expect(deriveApprovalStatus(snapshot(votes, { quorum: bad }), T0)).not.toBe('approved');
		});
	}
});

describe('isApproved — the sole release signal', () => {
	it('true only for a quorum-approved unexpired request', () => {
		expect(isApproved(snapshot([approve('U1'), approve('U2')], { quorum: 2 }), T0)).toBe(true);
		expect(isApproved(snapshot([approve('U1')], { quorum: 2 }), T0)).toBe(false);
		expect(isApproved(snapshot([reject('U1')], { quorum: 1 }), T0)).toBe(false);
	});
});
