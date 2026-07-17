import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';

// Fix the tenant so the singleton-org lookup is deterministic in the harness.
vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return { ...actual, getSingletonOrganizationId: vi.fn(async () => 'test-org') };
});

// `../../**` skips the importer's own subtree (`slack/`), so re-add the slack
// modules via a local glob remapped to the root-relative prefix convex-test
// expects — same workaround as mail/__tests__/sealedBlobHttp.test.ts.
const modules = {
	...import.meta.glob('../../**/*.*s'),
	...Object.fromEntries(
		Object.entries(import.meta.glob('../**/*.*s')).map(([path, mod]) => [
			path.replace(/^\.\.\//, '../../slack/'),
			mod,
		])
	),
};

async function seedMessage(t: TestConvex<typeof schema>): Promise<Id<'inboundMessages'>> {
	return t.run(async (ctx) =>
		ctx.db.insert('inboundMessages', {
			messageId: `mid-${Math.random()}`,
			from: 'alice@customer.example',
			to: 'support@example.test',
			subject: 'Order question',
			processingStatus: 'drafting',
			receivedAt: Date.now(),
		})
	);
}

async function tokenFor(
	t: TestConvex<typeof schema>,
	inboundMessageId: Id<'inboundMessages'>
): Promise<string> {
	const row = await t.run(async (ctx) =>
		ctx.db
			.query('slackApprovalRequests')
			.withIndex('by_org_and_message', (q) =>
				q.eq('organizationId', 'test-org').eq('inboundMessageId', inboundMessageId)
			)
			.unique()
	);
	if (!row) throw new Error('no approval request');
	return row.approvalToken;
}

describe('ensureHold — creates once, holds, and is idempotent', () => {
	it('creates a pending hold record on first evaluation', async () => {
		const t = convexTest(schema, modules);
		const inboundMessageId = await seedMessage(t);

		const decision = await t.mutation(internal.slack.approvals.ensureHold, {
			inboundMessageId,
			quorum: 2,
			ttlMs: 60_000,
		});
		expect(decision).toEqual({ release: false, status: 'pending' });

		const status = await t.query(internal.slack.approvals.getHoldStatus, { inboundMessageId });
		expect(status).toEqual({ exists: true, status: 'pending' });
	});

	it('reuses the same record on repeat evaluation (no duplicate rows)', async () => {
		const t = convexTest(schema, modules);
		const inboundMessageId = await seedMessage(t);

		await t.mutation(internal.slack.approvals.ensureHold, {
			inboundMessageId,
			quorum: 1,
			ttlMs: 60_000,
		});
		await t.mutation(internal.slack.approvals.ensureHold, {
			inboundMessageId,
			quorum: 1,
			ttlMs: 60_000,
		});

		const count = await t.run(async (ctx) => {
			const rows = await ctx.db
				.query('slackApprovalRequests')
				.withIndex('by_org_and_message', (q) =>
					q.eq('organizationId', 'test-org').eq('inboundMessageId', inboundMessageId)
				)
				.collect();
			return rows.length;
		});
		expect(count).toBe(1);
	});
});

describe('recordApprovalVote — quorum, dedup, reject, unknown', () => {
	it('holds until quorum, then reports approved', async () => {
		const t = convexTest(schema, modules);
		const inboundMessageId = await seedMessage(t);
		await t.mutation(internal.slack.approvals.ensureHold, {
			inboundMessageId,
			quorum: 2,
			ttlMs: 60_000,
		});
		const token = await tokenFor(t, inboundMessageId);

		const first = await t.mutation(internal.slack.approvals.recordApprovalVote, {
			approvalToken: token,
			slackUserId: 'U1',
			decision: 'approve',
			votedAt: Date.now(),
		});
		expect(first).toEqual({ recorded: true, status: 'pending' });

		const second = await t.mutation(internal.slack.approvals.recordApprovalVote, {
			approvalToken: token,
			slackUserId: 'U2',
			decision: 'approve',
			votedAt: Date.now(),
		});
		expect(second).toEqual({ recorded: true, status: 'approved' });

		const status = await t.query(internal.slack.approvals.getHoldStatus, { inboundMessageId });
		expect(status.status).toBe('approved');
	});

	it('a duplicate vote from the same user is idempotent (no quorum inflation)', async () => {
		const t = convexTest(schema, modules);
		const inboundMessageId = await seedMessage(t);
		await t.mutation(internal.slack.approvals.ensureHold, {
			inboundMessageId,
			quorum: 2,
			ttlMs: 60_000,
		});
		const token = await tokenFor(t, inboundMessageId);

		await t.mutation(internal.slack.approvals.recordApprovalVote, {
			approvalToken: token,
			slackUserId: 'U1',
			decision: 'approve',
			votedAt: Date.now(),
		});
		const dup = await t.mutation(internal.slack.approvals.recordApprovalVote, {
			approvalToken: token,
			slackUserId: 'U1',
			decision: 'approve',
			votedAt: Date.now(),
		});
		expect(dup.recorded).toBe(false);

		const votes = await t.run(async (ctx) => {
			const row = await ctx.db
				.query('slackApprovalRequests')
				.withIndex('by_token', (q) => q.eq('approvalToken', token))
				.unique();
			return row?.votes.length;
		});
		expect(votes).toBe(1);
		const status = await t.query(internal.slack.approvals.getHoldStatus, { inboundMessageId });
		expect(status.status).toBe('pending');
	});

	it('a reject holds regardless of approvals', async () => {
		const t = convexTest(schema, modules);
		const inboundMessageId = await seedMessage(t);
		await t.mutation(internal.slack.approvals.ensureHold, {
			inboundMessageId,
			quorum: 1,
			ttlMs: 60_000,
		});
		const token = await tokenFor(t, inboundMessageId);

		await t.mutation(internal.slack.approvals.recordApprovalVote, {
			approvalToken: token,
			slackUserId: 'U1',
			decision: 'reject',
			votedAt: Date.now(),
		});
		const status = await t.query(internal.slack.approvals.getHoldStatus, { inboundMessageId });
		expect(status.status).toBe('rejected');
	});

	it('an unknown token records nothing and reveals nothing', async () => {
		const t = convexTest(schema, modules);
		const result = await t.mutation(internal.slack.approvals.recordApprovalVote, {
			approvalToken: 'does-not-exist',
			slackUserId: 'U1',
			decision: 'approve',
			votedAt: Date.now(),
		});
		expect(result).toEqual({ recorded: false, status: 'unknown' });
	});
});

describe('getHoldStatus — no record', () => {
	it('reports none when nothing is held', async () => {
		const t = convexTest(schema, modules);
		const inboundMessageId = await seedMessage(t);
		const status = await t.query(internal.slack.approvals.getHoldStatus, { inboundMessageId });
		expect(status).toEqual({ exists: false, status: 'none' });
	});
});
