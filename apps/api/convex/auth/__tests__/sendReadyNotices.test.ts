/**
 * "You can send now" notices (auth/sendReadyNotices).
 *
 * The trigger is an EDGE on a derived level, which is exactly where this kind of
 * feature goes wrong, so both halves are pinned:
 *   - the pure decision: baseline vs edge classification, and which members are
 *     owed a notice (open first-send step, not dismissed, not already pending,
 *     and able to send FROM something);
 *   - the wiring, end to end over a real (convex-test) datastore and a real
 *     environment flip: the first sample only records a baseline (an instance
 *     that could always send never notifies anyone), the no-transport →
 *     transport sample notifies exactly the waiting members, a repeat sample
 *     notifies nobody twice, and a member's own session can read the notice back
 *     and acknowledge it once — without touching anyone else's.
 */

import { convexTest } from 'convex-test';
import { afterEach, describe, it, expect, vi } from 'vitest';
import schema from '../../schema';
import { api, internal } from '../../_generated/api';
import {
	classifyReadinessEdge,
	selectWaitingMembers,
	type WaitingMember,
} from '../sendReadyNotices';

const sessionMocks = vi.hoisted(() => ({ userId: 'user-A' }));

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn(async () => ({
			userId: sessionMocks.userId,
			role: 'editor' as const,
			activeOrganizationId: 'org-1',
		})),
		getMutationContext: vi.fn(async () => ({
			userId: sessionMocks.userId,
			role: 'editor' as const,
			activeOrganizationId: 'org-1',
		})),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
	};
});

/**
 * Readiness is env-derived (the MTA the personal-mail transport dispatches
 * through), which is exactly how a self-hoster turns sending on — so the tests
 * flip the real environment rather than mocking the resolution away.
 */
function setTransportConfigured(configured: boolean): void {
	if (configured) {
		vi.stubEnv('MTA_API_URL', 'https://mta.example.com');
		vi.stubEnv('MTA_API_KEY', 'mta-key');
	} else {
		vi.stubEnv('MTA_API_URL', '');
		vi.stubEnv('MTA_API_KEY', '');
		// …and no campaign/transactional provider either, so "no outbound path"
		// really means none.
		vi.stubEnv('EMAIL_PROVIDER', '');
	}
}

afterEach(() => {
	vi.unstubAllEnvs();
});

const allModules = import.meta.glob('../../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).map(([key, val]) =>
		key.startsWith('../') && !key.startsWith('../../')
			? (['../../auth/' + key.slice(3), val] as const)
			: ([key, val] as const)
	)
);

type MemberSeed = {
	authUserId: string;
	firstSendDone?: number;
	dismissedAt?: number;
	/** Omit to seed a member with no mailbox at all. */
	noMailbox?: boolean;
};

async function seedMembers(
	t: ReturnType<typeof convexTest>,
	members: readonly MemberSeed[]
): Promise<void> {
	await t.run(async (ctx) => {
		for (const { noMailbox, ...member } of members) {
			await ctx.db.insert('userOnboarding', {
				...member,
				createdAt: 1_000,
				updatedAt: 1_000,
			});
			if (noMailbox) continue;
			await ctx.db.insert('mailboxes', {
				userId: member.authUserId,
				organizationId: 'org-1',
				address: `${member.authUserId}@example.com`,
				domain: 'example.com',
				scope: 'personal',
				kind: 'hosted',
				status: 'active',
				usedBytes: 0,
				uidValidity: 1_000,
				createdAt: 1_000,
				updatedAt: 1_000,
			});
		}
	});
}

async function noticeUserIds(t: ReturnType<typeof convexTest>): Promise<string[]> {
	return await t.run(async (ctx) => {
		const rows = await ctx.db.query('sendReadyNotices').collect();
		return rows.map((row) => row.userId).sort();
	});
}

describe('readiness edge classification', () => {
	it('treats the first sample as a baseline, never an edge', () => {
		expect(classifyReadinessEdge(null, true)).toBe('baseline');
		expect(classifyReadinessEdge(null, false)).toBe('baseline');
	});

	it('reports only real transitions', () => {
		expect(classifyReadinessEdge(false, true)).toBe('became_ready');
		expect(classifyReadinessEdge(true, false)).toBe('became_unready');
		expect(classifyReadinessEdge(true, true)).toBe('unchanged');
		expect(classifyReadinessEdge(false, false)).toBe('unchanged');
	});
});

describe('waiting-member selection', () => {
	const member = (over: Partial<WaitingMember> & { authUserId: string }): WaitingMember => ({
		firstSendDone: null,
		dismissedAt: null,
		hasPendingNotice: false,
		canSendNow: true,
		...over,
	});

	it('notifies members whose first-send step is still open', () => {
		expect(
			selectWaitingMembers([member({ authUserId: 'a' }), member({ authUserId: 'b' })])
		).toEqual(['a', 'b']);
	});

	it('skips members who already sent, dismissed, or have a pending notice', () => {
		const selected = selectWaitingMembers([
			member({ authUserId: 'sent', firstSendDone: 5 }),
			member({ authUserId: 'dismissed', dismissedAt: 5 }),
			member({ authUserId: 'pending', hasPendingNotice: true }),
			member({ authUserId: 'waiting' }),
		]);
		expect(selected).toEqual(['waiting']);
	});

	it('never promises sending to a member whose own mail still cannot leave', () => {
		expect(
			selectWaitingMembers([member({ authUserId: 'no-transport', canSendNow: false })])
		).toEqual([]);
	});
});

describe('syncSendPathReadiness', () => {
	it('records a baseline on the first sample without notifying anyone', async () => {
		const t = convexTest(schema, modules);
		setTransportConfigured(true);
		await seedMembers(t, [{ authUserId: 'user-A' }]);

		const result = await t.mutation(internal.auth.sendReadyNotices.syncSendPathReadiness, {});

		expect(result).toEqual({ edge: 'baseline', notified: 0 });
		expect(await noticeUserIds(t)).toEqual([]);
	});

	it('notifies exactly the waiting members when the transport lands', async () => {
		const t = convexTest(schema, modules);
		setTransportConfigured(false);
		await seedMembers(t, [
			{ authUserId: 'waiting' },
			{ authUserId: 'already-sent', firstSendDone: 2_000 },
			{ authUserId: 'dismissed', dismissedAt: 2_000 },
			// Nothing to send FROM — their blocker is the mailbox step, not sending.
			{ authUserId: 'no-mailbox', noMailbox: true },
		]);
		await t.mutation(internal.auth.sendReadyNotices.syncSendPathReadiness, {});

		setTransportConfigured(true);
		const result = await t.mutation(internal.auth.sendReadyNotices.syncSendPathReadiness, {});

		expect(result).toEqual({ edge: 'became_ready', notified: 1 });
		expect(await noticeUserIds(t)).toEqual(['waiting']);
	});

	it('does not stack notices while an earlier one is still pending', async () => {
		const t = convexTest(schema, modules);
		setTransportConfigured(false);
		await seedMembers(t, [{ authUserId: 'waiting' }]);
		await t.mutation(internal.auth.sendReadyNotices.syncSendPathReadiness, {});

		setTransportConfigured(true);
		await t.mutation(internal.auth.sendReadyNotices.syncSendPathReadiness, {});
		// A transport that flaps away and back must not produce a second nudge.
		setTransportConfigured(false);
		await t.mutation(internal.auth.sendReadyNotices.syncSendPathReadiness, {});
		setTransportConfigured(true);
		const result = await t.mutation(internal.auth.sendReadyNotices.syncSendPathReadiness, {});

		expect(result.notified).toBe(0);
		expect(await noticeUserIds(t)).toEqual(['waiting']);
	});

	it('is a no-op while readiness is unchanged', async () => {
		const t = convexTest(schema, modules);
		setTransportConfigured(false);
		await seedMembers(t, [{ authUserId: 'waiting' }]);
		await t.mutation(internal.auth.sendReadyNotices.syncSendPathReadiness, {});

		const result = await t.mutation(internal.auth.sendReadyNotices.syncSendPathReadiness, {});

		expect(result).toEqual({ edge: 'unchanged', notified: 0 });
		expect(await noticeUserIds(t)).toEqual([]);
	});
});

describe('member-facing state', () => {
	it('surfaces the caller’s own pending notice, then clears it on acknowledge', async () => {
		const t = convexTest(schema, modules);
		sessionMocks.userId = 'user-A';
		setTransportConfigured(false);
		await seedMembers(t, [{ authUserId: 'user-A' }, { authUserId: 'user-B' }]);
		await t.mutation(internal.auth.sendReadyNotices.syncSendPathReadiness, {});
		setTransportConfigured(true);
		await t.mutation(internal.auth.sendReadyNotices.syncSendPathReadiness, {});

		const before = await t.query(api.auth.sendReadyNotices.getState, {});
		expect(before.isReady).toBe(true);
		expect(before.notices).toHaveLength(1);

		await t.mutation(api.auth.sendReadyNotices.acknowledge, {});

		const after = await t.query(api.auth.sendReadyNotices.getState, {});
		expect(after.notices).toEqual([]);
		// Another member's notice is untouched by this member's acknowledgement.
		sessionMocks.userId = 'user-B';
		expect((await t.query(api.auth.sendReadyNotices.getState, {})).notices).toHaveLength(1);
	});
});
