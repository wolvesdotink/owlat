/**
 * Team-inbox thread snooze coverage (inbox/snooze.ts + inbox/queries.ts +
 * inbox/threads/module.ts):
 *   - snoozeThread hides the thread from the Open filter (but not from All)
 *   - unsnoozeThread clears the snooze
 *   - the wake cron (internalSweep) floats due threads back with a
 *     `snoozeReturnedAt` marker and leaves not-yet-due ones snoozed
 *   - an inbound reply on a snoozed thread clears the snooze early AND reopens a
 *     resolved thread (the shared inbound_activity reducer)
 *   - snoozeThread rejects a past timestamp.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { enableFeatures } from './factories';
import { transition } from '../inbox/threads/module';

const sessionMock = vi.hoisted(() => ({
	user: { id: 'user-owner', role: 'owner' as 'owner' | 'admin' | 'editor' },
}));

const setUser = (id: string, role: 'owner' | 'admin' | 'editor' = 'owner') => {
	sessionMock.user.id = id;
	sessionMock.user.role = role;
};

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<typeof import('../lib/sessionOrganization')>(
		'../lib/sessionOrganization'
	);
	return {
		...actual,
		requireOrgMember: vi.fn().mockImplementation(async () => ({
			userId: sessionMock.user.id,
			role: sessionMock.user.role,
		})),
		getMutationContext: vi.fn().mockImplementation(async () => ({
			userId: sessionMock.user.id,
			role: sessionMock.user.role,
		})),
		requireAdminContext: vi.fn().mockImplementation(async () => {
			if (sessionMock.user.role === 'editor') throw new Error('forbidden');
			return { userId: sessionMock.user.id, role: sessionMock.user.role };
		}),
		isActiveOrgMember: vi.fn().mockImplementation(async () => true),
		getBetterAuthSessionWithRole: vi.fn().mockImplementation(async () => ({
			userId: sessionMock.user.id,
			activeOrganizationId: 'org-singleton',
			role: sessionMock.user.role,
		})),
	};
});

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('agentSecurity') &&
			!path.includes('agentContext') &&
			!path.includes('agentClassifier') &&
			!path.includes('agentDrafter') &&
			!path.includes('agentRouter') &&
			!path.includes('agent/walker') &&
			!path.includes('agent/steps/index') &&
			!path.includes('agent/steps/shared') &&
			!path.includes('agent/steps/classify') &&
			!path.includes('agent/steps/draft') &&
			!path.includes('knowledgeExtraction') &&
			!path.includes('semanticFileProcessing') &&
			!path.includes('visualizationAgent') &&
			!path.includes('llmProvider')
	)
);

const seedThread = async (
	t: TestConvex<typeof schema>,
	overrides: Partial<{
		status: 'open' | 'waiting' | 'resolved' | 'closed';
		snoozedUntil: number;
		snoozeReturnedAt: number;
		lastMessageAt: number;
	}> = {}
) =>
	t.run(async (ctx) => {
		const now = Date.now();
		return ctx.db.insert('conversationThreads', {
			subject: 'ticket',
			normalizedSubject: 'ticket',
			contactIdentifier: 'customer@example.com',
			status: overrides.status ?? 'open',
			...(overrides.snoozedUntil !== undefined ? { snoozedUntil: overrides.snoozedUntil } : {}),
			...(overrides.snoozeReturnedAt !== undefined
				? { snoozeReturnedAt: overrides.snoozeReturnedAt }
				: {}),
			messageCount: 1,
			lastMessageAt: overrides.lastMessageAt ?? now,
			firstMessageAt: now,
			createdAt: now,
		});
	});

const getThread = (t: TestConvex<typeof schema>, id: Id<'conversationThreads'>) =>
	t.run(async (ctx) => ctx.db.get(id));

beforeEach(() => {
	setUser('user-owner', 'owner');
});

describe('inbox thread snooze', () => {
	it('snoozeThread hides the thread from the Open filter but not from All', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['inbox']);
		const id = await seedThread(t);

		await t.mutation(api.inbox.snooze.snoozeThread, {
			threadId: id,
			until: Date.now() + 60 * 60 * 1000,
		});

		const open = await t.query(api.inbox.queries.listThreads, { status: 'open' });
		expect(open.threads.map((x) => x._id)).not.toContain(id);

		const all = await t.query(api.inbox.queries.listThreads, {});
		expect(all.threads.map((x) => x._id)).toContain(id);
	});

	it('rejects a snooze timestamp in the past', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['inbox']);
		const id = await seedThread(t);

		await expect(
			t.mutation(api.inbox.snooze.snoozeThread, { threadId: id, until: Date.now() - 1000 })
		).rejects.toThrow();
	});

	it('unsnoozeThread clears the snooze so the thread returns to Open', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['inbox']);
		const id = await seedThread(t, { snoozedUntil: Date.now() + 60 * 60 * 1000 });

		await t.mutation(api.inbox.snooze.unsnoozeThread, { threadId: id });

		const row = await getThread(t, id);
		expect(row?.snoozedUntil).toBeUndefined();

		const open = await t.query(api.inbox.queries.listThreads, { status: 'open' });
		expect(open.threads.map((x) => x._id)).toContain(id);
	});

	it('the wake cron floats due threads back with a returned marker, leaving not-yet-due ones snoozed', async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();
		const due = await seedThread(t, { snoozedUntil: now - 1000 });
		const future = await seedThread(t, { snoozedUntil: now + 60 * 60 * 1000 });

		const result = await t.mutation(internal.inbox.snooze.internalSweep, {});
		expect(result.woken).toBe(1);

		const dueRow = await getThread(t, due);
		expect(dueRow?.snoozedUntil).toBeUndefined();
		expect(dueRow?.snoozeReturnedAt).toBeGreaterThan(0);

		const futureRow = await getThread(t, future);
		expect(futureRow?.snoozedUntil).toBe(now + 60 * 60 * 1000);
		expect(futureRow?.snoozeReturnedAt).toBeUndefined();
	});

	it('an inbound reply clears an active snooze and reopens a resolved thread', async () => {
		const t = convexTest(schema, modules);
		const id = await seedThread(t, {
			status: 'resolved',
			snoozedUntil: Date.now() + 60 * 60 * 1000,
		});

		const at = Date.now();
		await t.run(async (ctx) => {
			await transition(ctx, { threadId: id, input: { kind: 'inbound_activity', occurredAt: at } });
		});

		const row = await getThread(t, id);
		expect(row?.status).toBe('open');
		expect(row?.snoozedUntil).toBeUndefined();
		expect(row?.snoozeReturnedAt).toBe(at);
	});
});
