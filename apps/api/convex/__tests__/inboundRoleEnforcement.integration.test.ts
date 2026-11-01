import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import * as sessionOrganization from '../lib/sessionOrganization';
import type { OrganizationRole } from '../lib/sessionOrganization';
import {
	createTestContact,
	createTestInboundMessage,
	createTestConversationThread,
	enableFeatures,
} from './factories';

/**
 * Role-enforcement tests for the AI-assisted shared inbox.
 *
 * Per the inbox access policy, the shared inbox is owner/admin
 * only: its mutations use the `adminMutation` wrapper (→ requireAdminContext)
 * and its queries gate on `getBetterAuthSessionWithRole`. An `editor` must be
 * rejected (mutations) or receive empty results (queries); owner/admin succeed.
 */

let mockRole: OrganizationRole = 'owner';

vi.mock('../lib/sessionOrganization', async () => {
	const actual: typeof sessionOrganization = await vi.importActual<typeof sessionOrganization>(
		'../lib/sessionOrganization'
	);
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn(async () => ({
			userId: 'test-user',
			role: mockRole,
			activeOrganizationId: 'org-test',
		})),
		requireAdminContext: vi.fn(async () => {
			if (mockRole !== 'owner' && mockRole !== 'admin') {
				throw new Error('Only owners and admins can perform this action');
			}
			return { userId: 'test-user', role: mockRole, activeOrganizationId: 'org-test' };
		}),
		requireOrgPermission: vi.fn(
			async (
				_ctx: unknown,
				permission: Parameters<typeof actual.hasPermission>[1],
				message?: string
			) => {
				actual.requirePermission(actual.hasPermission(mockRole, permission), message);
				return { userId: 'test-user', role: mockRole, activeOrganizationId: 'org-test' };
			}
		),
		getBetterAuthSessionWithRole: vi.fn(async () => ({
			userId: 'test-user',
			activeOrganizationId: 'org-test',
			role: mockRole,
		})),
	};
});
vi.mock('../lib/posthogHelpers', async () => ({
	trackEvent: vi.fn().mockResolvedValue(undefined),
}));

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
			!path.includes('files/processing') &&
			!path.includes('visualizationAgent') &&
			!path.includes('llmProvider')
	)
);

function threadData(overrides: Record<string, unknown> = {}) {
	const { updatedAt, channel, ...rest } = createTestConversationThread(overrides);
	return rest;
}
function msgData(overrides: Record<string, unknown> = {}) {
	return createTestInboundMessage({ threadId: undefined, contactId: undefined, ...overrides });
}

const testIdentity = {
	subject: 'test-user-123',
	issuer: 'https://test.issuer.com',
	tokenIdentifier: 'https://test.issuer.com|test-user-123',
};

beforeEach(() => {
	mockRole = 'owner';
});

describe('inbox role enforcement — approveDraft (mutation)', () => {
	async function seedDraft(t: ReturnType<typeof convexTest>): Promise<Id<'inboundMessages'>> {
		let messageId!: Id<'inboundMessages'>;
		await t.run(async (ctx) => {
			messageId = await ctx.db.insert(
				'inboundMessages',
				msgData({ processingStatus: 'draft_ready', draftResponse: 'Draft reply' })
			);
		});
		return messageId;
	}

	it('rejects an editor', async () => {
		const t = convexTest(schema, modules);
		const messageId = await seedDraft(t);
		mockRole = 'editor';
		await expect(
			t.withIdentity(testIdentity).mutation(api.inbox.mutations.approveDraft, {
				inboundMessageId: messageId,
			})
		).rejects.toThrow(/owners and admins/i);
	});

	it('allows an admin', async () => {
		const t = convexTest(schema, modules);
		const messageId = await seedDraft(t);
		mockRole = 'admin';
		const result = await t
			.withIdentity(testIdentity)
			.mutation(api.inbox.mutations.approveDraft, { inboundMessageId: messageId });
		expect(result.success).toBe(true);
	});
});

describe('inbox role enforcement — markThreadSeen (mutation)', () => {
	async function seedThread(t: ReturnType<typeof convexTest>): Promise<Id<'conversationThreads'>> {
		let threadId!: Id<'conversationThreads'>;
		await t.run(async (ctx) => {
			const contactId = await ctx.db.insert('contacts', createTestContact());
			threadId = await ctx.db.insert('conversationThreads', threadData({ contactId }));
		});
		return threadId;
	}

	/**
	 * The per-user unread marker is a read-side badge, but it is still a WRITE
	 * against an arbitrary thread id, and an editor cannot read the shared inbox
	 * at all — so it sits on the same floor as the rest.
	 */
	it('rejects an editor', async () => {
		const t = convexTest(schema, modules);
		const threadId = await seedThread(t);
		mockRole = 'editor';
		await expect(
			t.withIdentity(testIdentity).mutation(api.inbox.reads.markThreadSeen, { threadId })
		).rejects.toThrow(/owners and admins/i);

		const rows = await t.run(async (ctx) => await ctx.db.query('threadReads').collect());
		expect(rows).toHaveLength(0);
	});

	it('allows an admin', async () => {
		const t = convexTest(schema, modules);
		const threadId = await seedThread(t);
		mockRole = 'admin';
		const result = await t
			.withIdentity(testIdentity)
			.mutation(api.inbox.reads.markThreadSeen, { threadId });
		expect(result.success).toBe(true);
	});
});

describe('inbox role enforcement — listThreads (query)', () => {
	async function seedThread(t: ReturnType<typeof convexTest>) {
		await enableFeatures(t, ['inbox']);
		await t.run(async (ctx) => {
			const contactId = await ctx.db.insert('contacts', createTestContact());
			await ctx.db.insert('conversationThreads', threadData({ contactId }));
		});
	}

	it('returns empty for an editor', async () => {
		const t = convexTest(schema, modules);
		await seedThread(t);
		mockRole = 'editor';
		const result = await t.withIdentity(testIdentity).query(api.inbox.queries.listThreads, {});
		expect(result.threads).toHaveLength(0);
	});

	it('returns threads for an admin', async () => {
		const t = convexTest(schema, modules);
		await seedThread(t);
		mockRole = 'admin';
		const result = await t.withIdentity(testIdentity).query(api.inbox.queries.listThreads, {});
		expect(result.threads).toHaveLength(1);
	});
});

describe('inbox handlers read the session their builder floor resolved', () => {
	const adminFloor = vi.mocked(sessionOrganization.requireAdminContext);
	const memberFloor = vi.mocked(sessionOrganization.getMutationContext);
	const reResolvers = [
		vi.mocked(sessionOrganization.getBetterAuthSessionWithRole),
		vi.mocked(sessionOrganization.getUserIdFromSession),
		vi.mocked(sessionOrganization.requireOrgPermission),
	];
	function clearSessionMocks() {
		for (const mock of [adminFloor, memberFloor, ...reResolvers]) mock.mockClear();
	}

	it('admin-floored thread actions resolve once and attribute the floor user', async () => {
		const t = convexTest(schema, modules);
		mockRole = 'admin';
		let threadId!: Id<'conversationThreads'>;
		let messageId!: Id<'inboundMessages'>;
		await t.run(async (ctx) => {
			const contactId = await ctx.db.insert('contacts', createTestContact());
			threadId = await ctx.db.insert('conversationThreads', threadData({ contactId }));
			messageId = await ctx.db.insert(
				'inboundMessages',
				msgData({ processingStatus: 'draft_ready', draftResponse: 'Draft reply' })
			);
		});
		clearSessionMocks();

		const asCaller = t.withIdentity(testIdentity);
		await asCaller.mutation(api.inbox.reads.markThreadSeen, { threadId });
		await asCaller.mutation(api.inbox.presence.heartbeat, { threadId, mode: 'viewing' });
		await asCaller.mutation(api.inbox.presence.leave, { threadId });
		await asCaller.mutation(api.inbox.snooze.snoozeThread, {
			threadId,
			until: Date.now() + 60 * 60 * 1000,
		});
		await asCaller.mutation(api.inbox.snooze.unsnoozeThread, { threadId });
		await asCaller.mutation(api.inbox.mutations.approveDraft, { inboundMessageId: messageId });

		expect(adminFloor).toHaveBeenCalledTimes(6);
		expect(memberFloor).not.toHaveBeenCalled();
		for (const mock of reResolvers) expect(mock).not.toHaveBeenCalled();

		const reads = await t.run(async (ctx) => await ctx.db.query('threadReads').collect());
		expect(reads.map((r) => r.userId)).toEqual(['test-user']);
	});

	it('setAskEagerness checks organization:manage on the floor session', async () => {
		const t = convexTest(schema, modules);

		mockRole = 'editor';
		clearSessionMocks();
		await expect(
			t
				.withIdentity(testIdentity)
				.mutation(api.inbox.askEagernessSettings.setAskEagerness, { mode: 'cautious' })
		).rejects.toThrow('Only owners and admins can change the ask-eagerness setting');
		expect(
			await t.run(async (ctx) => await ctx.db.query('askEagernessSettings').collect())
		).toHaveLength(0);

		mockRole = 'admin';
		await t
			.withIdentity(testIdentity)
			.mutation(api.inbox.askEagernessSettings.setAskEagerness, { mode: 'cautious' });
		const rows = await t.run(async (ctx) => await ctx.db.query('askEagernessSettings').collect());
		expect(rows.map((r) => r.mode)).toEqual(['cautious']);

		expect(memberFloor).toHaveBeenCalledTimes(2);
		for (const mock of reResolvers) expect(mock).not.toHaveBeenCalled();
	});
});
