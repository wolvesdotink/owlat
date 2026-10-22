/**
 * Team Inbox thread priority (inbox/priority.ts):
 *   - an admin sets urgent / low, and `normal` clears the stored field, so an
 *     old row without the field and a row set back to normal read the same;
 *   - each real change is audited with its from/to, a repeat is a no-op;
 *   - a member who is not an admin cannot set it.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { enableFeatures } from './factories';

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

const seedThread = async (t: TestConvex<typeof schema>) =>
	t.run(async (ctx) => {
		const now = Date.now();
		return ctx.db.insert('conversationThreads', {
			subject: 'ticket',
			normalizedSubject: 'ticket',
			contactIdentifier: 'customer@example.com',
			status: 'open',
			messageCount: 1,
			lastMessageAt: now,
			firstMessageAt: now,
			createdAt: now,
		});
	});

const getThread = (t: TestConvex<typeof schema>, id: Id<'conversationThreads'>) =>
	t.run(async (ctx) => ctx.db.get(id));

const priorityAudits = (t: TestConvex<typeof schema>) =>
	t.run(async (ctx) =>
		(await ctx.db.query('auditLogs').collect())
			.filter((row) => row.action === 'thread.priority_changed')
			.map((row) => row.details)
	);

beforeEach(() => {
	setUser('user-owner', 'owner');
});

describe('inbox thread priority', () => {
	it('stores urgent and low, and clears the field when set back to normal', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['inbox']);
		const id = await seedThread(t);
		expect((await getThread(t, id))?.priority).toBeUndefined();

		await t.mutation(api.inbox.priority.setThreadPriority, { threadId: id, priority: 'urgent' });
		expect((await getThread(t, id))?.priority).toBe('urgent');

		await t.mutation(api.inbox.priority.setThreadPriority, { threadId: id, priority: 'low' });
		expect((await getThread(t, id))?.priority).toBe('low');

		await t.mutation(api.inbox.priority.setThreadPriority, { threadId: id, priority: 'normal' });
		const cleared = await getThread(t, id);
		expect(cleared).not.toBeNull();
		expect('priority' in (cleared ?? {})).toBe(false);
	});

	it('audits each change with where it came from, and skips a repeat', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['inbox']);
		const id = await seedThread(t);

		const first = await t.mutation(api.inbox.priority.setThreadPriority, {
			threadId: id,
			priority: 'urgent',
		});
		const repeat = await t.mutation(api.inbox.priority.setThreadPriority, {
			threadId: id,
			priority: 'urgent',
		});
		await t.mutation(api.inbox.priority.setThreadPriority, { threadId: id, priority: 'normal' });

		expect(first).toEqual({ changed: true });
		expect(repeat).toEqual({ changed: false });
		expect(await priorityAudits(t)).toEqual([
			{ from: 'normal', to: 'urgent' },
			{ from: 'urgent', to: 'normal' },
		]);
	});

	it('rejects a member who is not an admin', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['inbox']);
		const id = await seedThread(t);
		setUser('user-editor', 'editor');

		await expect(
			t.mutation(api.inbox.priority.setThreadPriority, { threadId: id, priority: 'urgent' })
		).rejects.toThrow();
		expect((await getThread(t, id))?.priority).toBeUndefined();
	});
});
