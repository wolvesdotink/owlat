import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
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
 * Per the inbox access policy (docs/adr/0040), the shared inbox is owner/admin
 * only: its mutations use the `adminMutation` wrapper (→ requireAdminContext)
 * and its queries gate on `getBetterAuthSessionWithRole`. An `editor` must be
 * rejected (mutations) or receive empty results (queries); owner/admin succeed.
 */

let mockRole: OrganizationRole = 'owner';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<typeof import('../lib/sessionOrganization')>(
		'../lib/sessionOrganization'
	);
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn(async () => ({ userId: 'test-user', role: mockRole })),
		requireAdminContext: vi.fn(async () => {
			if (mockRole !== 'owner' && mockRole !== 'admin') {
				throw new Error('Only owners and admins can perform this action');
			}
			return { userId: 'test-user', role: mockRole };
		}),
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
			!path.includes('semanticFileProcessing') &&
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
		const result = await t
			.withIdentity(testIdentity)
			.query(api.inbox.queries.listThreads, {});
		expect(result.threads).toHaveLength(0);
	});

	it('returns threads for an admin', async () => {
		const t = convexTest(schema, modules);
		await seedThread(t);
		mockRole = 'admin';
		const result = await t
			.withIdentity(testIdentity)
			.query(api.inbox.queries.listThreads, {});
		expect(result.threads).toHaveLength(1);
	});
});
