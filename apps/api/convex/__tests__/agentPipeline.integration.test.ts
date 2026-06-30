import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import {
	createTestContact,
	createTestInboundMessage,
	createTestConversationThread,
	createTestAgentAction,
	createTestAgentConfig,
	createTestContactActivity,
	enableFeatures,
} from './factories';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
	};
});
vi.mock('../lib/posthogHelpers', async () => ({
	trackEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../lib/contactCountHelpers', async () => {
	const actual = await vi.importActual('../lib/contactCountHelpers');
	return {
		...actual,
		incrementContactCount: vi.fn().mockResolvedValue(undefined),
		getCachedContactCount: vi.fn().mockResolvedValue(0),
		reconcileContactCount: vi.fn().mockResolvedValue(undefined),
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

/** Strip fields not in the conversationThreads schema */
function threadData(overrides: Record<string, unknown> = {}) {
	const { updatedAt, channel, ...rest } = createTestConversationThread(overrides);
	return rest;
}

/** Strip fields not in the agentConfig schema (the master toggle is now the
 * `ai.agent` feature flag — `isEnabled` is no longer a column). */
function configData(overrides: Record<string, unknown> = {}) {
	const { autoReplyCount, autoReplyCountResetAt, ...rest } = createTestAgentConfig(overrides);
	return rest;
}

/** Create inbound message data safe for ctx.db.insert (no fake IDs) */
function msgData(overrides: Record<string, unknown> = {}) {
	return createTestInboundMessage({ threadId: undefined, contactId: undefined, ...overrides });
}

// ============ Helper Queries ============

describe('agentPipeline.getMessage', () => {
	it('should return an inbound message by ID', async () => {
		const t = convexTest(schema, modules);

		let messageId!: Id<'inboundMessages'>;
		await t.run(async (ctx) => {
			const contactId = await ctx.db.insert('contacts', createTestContact());
			const threadId = await ctx.db.insert('conversationThreads', threadData({ contactId }));
			messageId = await ctx.db.insert('inboundMessages', msgData({ contactId, threadId }));
		});

		const result = await t.query(internal.agent.agentPipeline.getMessage, {
			inboundMessageId: messageId,
		});

		expect(result).toBeDefined();
		expect(result!._id).toBe(messageId);
	});

	it('should return null for non-existent message', async () => {
		const t = convexTest(schema, modules);

		let fakeId!: Id<'inboundMessages'>;
		await t.run(async (ctx) => {
			const id = await ctx.db.insert('inboundMessages', msgData());
			await ctx.db.delete(id);
			fakeId = id;
		});

		const result = await t.query(internal.agent.agentPipeline.getMessage, {
			inboundMessageId: fakeId,
		});

		expect(result).toBeNull();
	});
});

describe('agentPipeline.getContact', () => {
	it('should return a contact by ID', async () => {
		const t = convexTest(schema, modules);

		let contactId!: Id<'contacts'>;
		await t.run(async (ctx) => {
			contactId = await ctx.db.insert('contacts', createTestContact({ email: 'test@example.com' }));
		});

		const result = await t.query(internal.agent.agentPipeline.getContact, { contactId });

		expect(result).toBeDefined();
		expect(result!.email).toBe('test@example.com');
	});
});

describe('agentPipeline.getRecentActivities', () => {
	it('should return recent activities for a contact', async () => {
		const t = convexTest(schema, modules);

		let contactId!: Id<'contacts'>;
		await t.run(async (ctx) => {
			contactId = await ctx.db.insert('contacts', createTestContact());
			for (let i = 0; i < 5; i++) {
				await ctx.db.insert(
					'contactActivities',
					createTestContactActivity({
						contactId,
						activityType: 'email_opened',
						metadata: { campaignId: 'test-campaign' },
						occurredAt: Date.now() - i * 1000,
					})
				);
			}
		});

		const result = await t.query(internal.agent.agentPipeline.getRecentActivities, {
			contactId,
			limit: 3,
		});

		expect(result).toHaveLength(3);
	});

	it('should return empty array for contact with no activities', async () => {
		const t = convexTest(schema, modules);

		let contactId!: Id<'contacts'>;
		await t.run(async (ctx) => {
			contactId = await ctx.db.insert('contacts', createTestContact());
		});

		const result = await t.query(internal.agent.agentPipeline.getRecentActivities, {
			contactId,
			limit: 10,
		});

		expect(result).toHaveLength(0);
	});
});

describe('agentPipeline.getThreadMessages', () => {
	it('should return messages in a thread', async () => {
		const t = convexTest(schema, modules);

		let threadId!: Id<'conversationThreads'>;
		await t.run(async (ctx) => {
			const contactId = await ctx.db.insert('contacts', createTestContact());
			threadId = await ctx.db.insert('conversationThreads', threadData({ contactId, messageCount: 3 }));
			for (let i = 0; i < 3; i++) {
				await ctx.db.insert('inboundMessages', msgData({ threadId, contactId, subject: `Message ${i}` }));
			}
		});

		const result = await t.query(internal.agent.agentPipeline.getThreadMessages, {
			threadId,
			limit: 10,
		});

		expect(result).toHaveLength(3);
	});

	it('should exclude a specific message when excludeMessageId is provided', async () => {
		const t = convexTest(schema, modules);

		let threadId!: Id<'conversationThreads'>;
		let excludeId!: Id<'inboundMessages'>;
		await t.run(async (ctx) => {
			const contactId = await ctx.db.insert('contacts', createTestContact());
			threadId = await ctx.db.insert('conversationThreads', threadData({ contactId, messageCount: 3 }));
			for (let i = 0; i < 3; i++) {
				const id = await ctx.db.insert('inboundMessages', msgData({ threadId, contactId, subject: `Msg ${i}` }));
				if (i === 1) excludeId = id;
			}
		});

		const result = await t.query(internal.agent.agentPipeline.getThreadMessages, {
			threadId,
			limit: 10,
			excludeMessageId: excludeId,
		});

		expect(result).toHaveLength(2);
		expect(result.every((m) => m._id !== excludeId)).toBe(true);
	});

	it('should respect the limit parameter', async () => {
		const t = convexTest(schema, modules);

		let threadId!: Id<'conversationThreads'>;
		await t.run(async (ctx) => {
			const contactId = await ctx.db.insert('contacts', createTestContact());
			threadId = await ctx.db.insert('conversationThreads', threadData({ contactId, messageCount: 5 }));
			for (let i = 0; i < 5; i++) {
				await ctx.db.insert('inboundMessages', msgData({ threadId, contactId }));
			}
		});

		const result = await t.query(internal.agent.agentPipeline.getThreadMessages, {
			threadId,
			limit: 2,
		});

		expect(result).toHaveLength(2);
	});
});

describe('agentPipeline.isAgentEnabled', () => {
	it('should return false when no feature flags are set', async () => {
		const t = convexTest(schema, modules);
		const result = await t.query(internal.agent.agentPipeline.isAgentEnabled, {});
		expect(result).toBe(false);
	});

	it('should return true when ai.agent flag is enabled', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.agent']);
		const result = await t.query(internal.agent.agentPipeline.isAgentEnabled, {});
		expect(result).toBe(true);
	});

	it('should return false when ai.agent is unset', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', {
				featureFlags: {},
				createdAt: Date.now(),
			});
		});
		const result = await t.query(internal.agent.agentPipeline.isAgentEnabled, {});
		expect(result).toBe(false);
	});
});

describe('agentPipeline.getAgentConfig', () => {
	it('should return null when no config exists', async () => {
		const t = convexTest(schema, modules);
		const result = await t.query(internal.agent.agentPipeline.getAgentConfig, {});
		expect(result).toBeNull();
	});

	it('should return config when it exists', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('agentConfig', configData({ confidenceThreshold: 0.9 }));
		});
		const result = await t.query(internal.agent.agentPipeline.getAgentConfig, {});
		expect(result).toBeDefined();
		expect(result!.confidenceThreshold).toBe(0.9);
	});
});

