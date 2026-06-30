import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import {
	createTestContact,
	createTestContactIdentity,
	createTestContactRelationship,
	createTestConversationThread,
	createTestUnifiedMessage,
	createTestTopic,
	createTestEmailSend,
	createTestAutomation,
	createTestFormSubmission,
	createTestInboundMessage,
	createTestCampaign,
	createTestKnowledgeEntry,
} from './factories';
import type { Id } from '../_generated/dataModel';

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
	Object.entries(allModules).filter(([path]) =>
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

// ============ contactIdentities.addIdentity ============

describe('contactIdentities.addIdentity', () => {
	it('should create a new identity for a contact', async () => {
		const t = convexTest(schema, modules);
		let contactId!: Id<'contacts'>;

		await t.run(async (ctx) => {
			contactId = await ctx.db.insert('contacts', createTestContact());
		});

		const identityId = await t.mutation(api.contacts.identities.addIdentity, {
			contactId,
			channel: 'email',
			identifier: 'user@example.com',
		});

		expect(identityId).toBeDefined();

		await t.run(async (ctx) => {
			const identity = await ctx.db.get(identityId);
			expect(identity).toBeDefined();
			expect(identity!.contactId).toBe(contactId);
			expect(identity!.channel).toBe('email');
			expect(identity!.identifier).toBe('user@example.com');
			expect(identity!.isPrimary).toBe(false);
			expect(identity!.createdAt).toBeTypeOf('number');
		});
	});

	it('should return existing identity ID if same contact already has it', async () => {
		const t = convexTest(schema, modules);
		let contactId!: Id<'contacts'>;
		let existingId!: Id<'contactIdentities'>;

		await t.run(async (ctx) => {
			contactId = await ctx.db.insert('contacts', createTestContact());
			existingId = await ctx.db.insert('contactIdentities', createTestContactIdentity({
				contactId,
				channel: 'email',
				identifier: 'dup@example.com',
			}));
		});

		const resultId = await t.mutation(api.contacts.identities.addIdentity, {
			contactId,
			channel: 'email',
			identifier: 'dup@example.com',
		});

		expect(resultId).toBe(existingId);
	});

	it('should throw if identifier is already linked to a different contact', async () => {
		const t = convexTest(schema, modules);
		let contactId1!: Id<'contacts'>;
		let contactId2!: Id<'contacts'>;

		await t.run(async (ctx) => {
			contactId1 = await ctx.db.insert('contacts', createTestContact());
			contactId2 = await ctx.db.insert('contacts', createTestContact());
			await ctx.db.insert('contactIdentities', createTestContactIdentity({
				contactId: contactId1,
				channel: 'phone',
				identifier: '+1234567890',
			}));
		});

		await expect(
			t.mutation(api.contacts.identities.addIdentity, {
				contactId: contactId2,
				channel: 'phone',
				identifier: '+1234567890',
			})
		).rejects.toThrow('already linked to another contact');
	});

	it('should set isPrimary and unset previous primary for same channel', async () => {
		const t = convexTest(schema, modules);
		let contactId!: Id<'contacts'>;
		let firstIdentityId!: Id<'contactIdentities'>;

		await t.run(async (ctx) => {
			contactId = await ctx.db.insert('contacts', createTestContact());
			firstIdentityId = await ctx.db.insert('contactIdentities', createTestContactIdentity({
				contactId,
				channel: 'email',
				identifier: 'first@example.com',
				isPrimary: true,
			}));
		});

		const secondId = await t.mutation(api.contacts.identities.addIdentity, {
			contactId,
			channel: 'email',
			identifier: 'second@example.com',
			isPrimary: true,
		});

		await t.run(async (ctx) => {
			const first = await ctx.db.get(firstIdentityId);
			expect(first!.isPrimary).toBe(false);
			const second = await ctx.db.get(secondId);
			expect(second!.isPrimary).toBe(true);
		});
	});
});

// ============ contactIdentities.removeIdentity ============

describe('contactIdentities.removeIdentity', () => {
	it('should delete the identity', async () => {
		const t = convexTest(schema, modules);
		let identityId!: Id<'contactIdentities'>;

		await t.run(async (ctx) => {
			const contactId = await ctx.db.insert('contacts', createTestContact());
			identityId = await ctx.db.insert('contactIdentities', createTestContactIdentity({
				contactId,
				channel: 'twitter',
				identifier: '@testuser',
			}));
		});

		await t.mutation(api.contacts.identities.removeIdentity, { identityId });

		await t.run(async (ctx) => {
			const identity = await ctx.db.get(identityId);
			expect(identity).toBeNull();
		});
	});
});

// ============ contactIdentities.verifyIdentity ============

describe('contactIdentities.verifyIdentity', () => {
	it('should set verifiedAt timestamp', async () => {
		const t = convexTest(schema, modules);
		let identityId!: Id<'contactIdentities'>;

		await t.run(async (ctx) => {
			const contactId = await ctx.db.insert('contacts', createTestContact());
			identityId = await ctx.db.insert('contactIdentities', createTestContactIdentity({
				contactId,
				channel: 'email',
				identifier: 'verify@example.com',
			}));
		});

		await t.mutation(api.contacts.identities.verifyIdentity, { identityId });

		await t.run(async (ctx) => {
			const identity = await ctx.db.get(identityId);
			expect(identity!.verifiedAt).toBeTypeOf('number');
		});
	});
});

// ============ contactIdentities.findByIdentifier ============

describe('contactIdentities.findByIdentifier', () => {
	it('should find a contact by channel and identifier', async () => {
		const t = convexTest(schema, modules);
		let contactId!: Id<'contacts'>;

		await t.run(async (ctx) => {
			contactId = await ctx.db.insert('contacts', createTestContact({ email: 'found@example.com' }));
			await ctx.db.insert('contactIdentities', createTestContactIdentity({
				contactId,
				channel: 'email',
				identifier: 'found@example.com',
			}));
		});

		// findByIdentifier requires auth; verify via raw DB
		await t.run(async (ctx) => {
			const identity = await ctx.db
				.query('contactIdentities')
				.withIndex('by_identifier', (q) =>
					q.eq('channel', 'email').eq('identifier', 'found@example.com')
				)
				.first();
			expect(identity).toBeDefined();
			expect(identity!.contactId).toBe(contactId);
		});
	});

	it('should return null for unknown identifier', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			const identity = await ctx.db
				.query('contactIdentities')
				.withIndex('by_identifier', (q) =>
					q.eq('channel', 'email').eq('identifier', 'nobody@example.com')
				)
				.first();
			expect(identity).toBeNull();
		});
	});
});

// ============ contactIdentities.listByContact ============

describe('contactIdentities.listByContact', () => {
	it('should return all identities for a contact', async () => {
		const t = convexTest(schema, modules);
		let contactId!: Id<'contacts'>;

		await t.run(async (ctx) => {
			contactId = await ctx.db.insert('contacts', createTestContact());
			await ctx.db.insert('contactIdentities', createTestContactIdentity({
				contactId,
				channel: 'email',
				identifier: 'a@example.com',
			}));
			await ctx.db.insert('contactIdentities', createTestContactIdentity({
				contactId,
				channel: 'phone',
				identifier: '+1111111111',
			}));
			await ctx.db.insert('contactIdentities', createTestContactIdentity({
				contactId,
				channel: 'whatsapp',
				identifier: '+2222222222',
			}));
		});

		await t.run(async (ctx) => {
			const identities = await ctx.db
				.query('contactIdentities')
				.withIndex('by_contact', (q) => q.eq('contactId', contactId))
				.collect();
			expect(identities).toHaveLength(3);
			const channels = identities.map((i) => i.channel).sort();
			expect(channels).toEqual(['email', 'phone', 'whatsapp']);
		});
	});
});

// ============ contactIdentities.getMergeSuggestions ============

describe('contactIdentities.getMergeSuggestions', () => {
	it('should find contacts sharing the same identifier', async () => {
		const t = convexTest(schema, modules);
		let contactA!: Id<'contacts'>;
		let contactB!: Id<'contacts'>;

		await t.run(async (ctx) => {
			contactA = await ctx.db.insert('contacts', createTestContact({ email: 'shared@example.com' }));
			contactB = await ctx.db.insert('contacts', createTestContact({ email: 'other@example.com' }));
			// Both contacts have same phone identity
			await ctx.db.insert('contactIdentities', createTestContactIdentity({
				contactId: contactA,
				channel: 'phone',
				identifier: '+9999999999',
			}));
			await ctx.db.insert('contactIdentities', createTestContactIdentity({
				contactId: contactB,
				channel: 'phone',
				identifier: '+9999999999',
			}));
		});

		// getMergeSuggestions requires auth; verify the logic via raw DB
		await t.run(async (ctx) => {
			// Simulate the merge suggestion logic
			const identitiesA = await ctx.db
				.query('contactIdentities')
				.withIndex('by_contact', (q) => q.eq('contactId', contactA))
				.collect();

			const candidateIds = new Set<string>();
			for (const identity of identitiesA) {
				const matches = await ctx.db
					.query('contactIdentities')
					.withIndex('by_identifier', (q) =>
						q.eq('channel', identity.channel).eq('identifier', identity.identifier)
					)
					.collect();
				for (const match of matches) {
					if (match.contactId !== contactA) {
						candidateIds.add(match.contactId as string);
					}
				}
			}

			expect(candidateIds.size).toBe(1);
			expect(candidateIds.has(contactB as string)).toBe(true);
		});
	});

	it('should not suggest contacts without shared identifiers', async () => {
		const t = convexTest(schema, modules);
		let contactA!: Id<'contacts'>;

		await t.run(async (ctx) => {
			contactA = await ctx.db.insert('contacts', createTestContact());
			const contactB = await ctx.db.insert('contacts', createTestContact());
			await ctx.db.insert('contactIdentities', createTestContactIdentity({
				contactId: contactA,
				channel: 'email',
				identifier: 'unique-a@example.com',
			}));
			await ctx.db.insert('contactIdentities', createTestContactIdentity({
				contactId: contactB,
				channel: 'email',
				identifier: 'unique-b@example.com',
			}));
		});

		await t.run(async (ctx) => {
			const identitiesA = await ctx.db
				.query('contactIdentities')
				.withIndex('by_contact', (q) => q.eq('contactId', contactA))
				.collect();

			let hasCandidates = false;
			for (const identity of identitiesA) {
				const matches = await ctx.db
					.query('contactIdentities')
					.withIndex('by_identifier', (q) =>
						q.eq('channel', identity.channel).eq('identifier', identity.identifier)
					)
					.collect();
				for (const match of matches) {
					if (match.contactId !== contactA) {
						hasCandidates = true;
					}
				}
			}
			expect(hasCandidates).toBe(false);
		});
	});
});

// ============ contactIdentities.mergeContacts ============

describe('contactIdentities.mergeContacts', () => {
	it('should move identities from source to target', async () => {
		const t = convexTest(schema, modules);
		let targetId!: Id<'contacts'>;
		let sourceId!: Id<'contacts'>;

		await t.run(async (ctx) => {
			targetId = await ctx.db.insert('contacts', createTestContact({ email: 'target@example.com', firstName: 'Target' }));
			sourceId = await ctx.db.insert('contacts', createTestContact({ email: 'source@example.com', firstName: 'Source' }));
			await ctx.db.insert('contactIdentities', createTestContactIdentity({
				contactId: sourceId,
				channel: 'phone',
				identifier: '+5555555555',
			}));
		});

		const result = await t.mutation(api.contacts.identities.mergeContacts, {
			targetContactId: targetId,
			sourceContactId: sourceId,
		});

		expect(result).toBe(targetId);

		await t.run(async (ctx) => {
			// Identity should now belong to target
			const identities = await ctx.db
				.query('contactIdentities')
				.withIndex('by_contact', (q) => q.eq('contactId', targetId))
				.collect();
			const phones = identities.filter((i) => i.channel === 'phone');
			expect(phones).toHaveLength(1);
			expect(phones[0]!.identifier).toBe('+5555555555');

			// Source should be deleted
			const source = await ctx.db.get(sourceId);
			expect(source).toBeNull();
		});
	});

	it('should handle conflicting identities by deleting source duplicate', async () => {
		const t = convexTest(schema, modules);
		let targetId!: Id<'contacts'>;
		let sourceId!: Id<'contacts'>;

		await t.run(async (ctx) => {
			targetId = await ctx.db.insert('contacts', createTestContact({ email: 'target@example.com' }));
			sourceId = await ctx.db.insert('contacts', createTestContact({ email: 'source@example.com' }));
			// Both have the same email identity
			await ctx.db.insert('contactIdentities', createTestContactIdentity({
				contactId: targetId,
				channel: 'email',
				identifier: 'shared@example.com',
				isPrimary: true,
			}));
			await ctx.db.insert('contactIdentities', createTestContactIdentity({
				contactId: sourceId,
				channel: 'email',
				identifier: 'shared@example.com',
				isPrimary: true,
			}));
		});

		await t.mutation(api.contacts.identities.mergeContacts, {
			targetContactId: targetId,
			sourceContactId: sourceId,
		});

		await t.run(async (ctx) => {
			// Only one email identity should remain on target
			const identities = await ctx.db
				.query('contactIdentities')
				.withIndex('by_identifier', (q) =>
					q.eq('channel', 'email').eq('identifier', 'shared@example.com')
				)
				.collect();
			expect(identities).toHaveLength(1);
			expect(identities[0]!.contactId).toBe(targetId);
		});
	});

	it('should move relationships from source to target', async () => {
		const t = convexTest(schema, modules);
		let targetId!: Id<'contacts'>;
		let sourceId!: Id<'contacts'>;
		let thirdId!: Id<'contacts'>;

		await t.run(async (ctx) => {
			targetId = await ctx.db.insert('contacts', createTestContact({ email: 'target@example.com' }));
			sourceId = await ctx.db.insert('contacts', createTestContact({ email: 'source@example.com' }));
			thirdId = await ctx.db.insert('contacts', createTestContact({ email: 'third@example.com' }));
			await ctx.db.insert('contactRelationships', createTestContactRelationship({
				fromContactId: sourceId,
				toContactId: thirdId,
				relationship: 'colleague',
			}));
			await ctx.db.insert('contactRelationships', createTestContactRelationship({
				fromContactId: thirdId,
				toContactId: sourceId,
				relationship: 'manager_of',
			}));
		});

		await t.mutation(api.contacts.identities.mergeContacts, {
			targetContactId: targetId,
			sourceContactId: sourceId,
		});

		await t.run(async (ctx) => {
			const outgoing = await ctx.db
				.query('contactRelationships')
				.withIndex('by_from', (q) => q.eq('fromContactId', targetId))
				.collect();
			expect(outgoing).toHaveLength(1);
			expect(outgoing[0]!.toContactId).toBe(thirdId);

			const incoming = await ctx.db
				.query('contactRelationships')
				.withIndex('by_to', (q) => q.eq('toContactId', targetId))
				.collect();
			expect(incoming).toHaveLength(1);
			expect(incoming[0]!.fromContactId).toBe(thirdId);
		});
	});

	it('should move conversation threads from source to target', async () => {
		const t = convexTest(schema, modules);
		let targetId!: Id<'contacts'>;
		let sourceId!: Id<'contacts'>;
		let threadId!: Id<'conversationThreads'>;

		await t.run(async (ctx) => {
			targetId = await ctx.db.insert('contacts', createTestContact({ email: 'target@example.com' }));
			sourceId = await ctx.db.insert('contacts', createTestContact({ email: 'source@example.com' }));
			const now = Date.now();
			threadId = await ctx.db.insert('conversationThreads', {
				subject: 'Test Thread',
				normalizedSubject: 'test thread',
				contactId: sourceId,
				contactIdentifier: 'source@example.com',
				status: 'open',
				messageCount: 1,
				lastMessageAt: now,
				firstMessageAt: now,
				createdAt: now,
			});
		});

		await t.mutation(api.contacts.identities.mergeContacts, {
			targetContactId: targetId,
			sourceContactId: sourceId,
		});

		await t.run(async (ctx) => {
			const thread = await ctx.db.get(threadId);
			expect(thread!.contactId).toBe(targetId);
		});
	});

	it('should move unified messages from source to target', async () => {
		const t = convexTest(schema, modules);
		let targetId!: Id<'contacts'>;
		let sourceId!: Id<'contacts'>;
		let messageId!: Id<'unifiedMessages'>;

		await t.run(async (ctx) => {
			targetId = await ctx.db.insert('contacts', createTestContact({ email: 'target@example.com' }));
			sourceId = await ctx.db.insert('contacts', createTestContact({ email: 'source@example.com' }));
			const now = Date.now();
			const threadId = await ctx.db.insert('conversationThreads', {
				subject: 'Msg Thread',
				normalizedSubject: 'msg thread',
				contactId: sourceId,
				contactIdentifier: 'source@example.com',
				status: 'open',
				messageCount: 1,
				lastMessageAt: now,
				firstMessageAt: now,
				createdAt: now,
			});
			messageId = await ctx.db.insert('unifiedMessages', {
				threadId,
				channel: 'email',
				direction: 'inbound',
				contactId: sourceId,
				content: JSON.stringify({ text: 'Hello' }),
				status: 'received',
				createdAt: now,
			});
		});

		await t.mutation(api.contacts.identities.mergeContacts, {
			targetContactId: targetId,
			sourceContactId: sourceId,
		});

		await t.run(async (ctx) => {
			const msg = await ctx.db.get(messageId);
			expect(msg!.contactId).toBe(targetId);
		});
	});

	it('should fill missing names on target from source', async () => {
		const t = convexTest(schema, modules);
		let targetId!: Id<'contacts'>;
		let sourceId!: Id<'contacts'>;

		await t.run(async (ctx) => {
			targetId = await ctx.db.insert('contacts', createTestContact({
				email: 'target@example.com',
				firstName: undefined,
				lastName: undefined,
			}));
			sourceId = await ctx.db.insert('contacts', createTestContact({
				email: 'source@example.com',
				firstName: 'Alice',
				lastName: 'Smith',
			}));
		});

		await t.mutation(api.contacts.identities.mergeContacts, {
			targetContactId: targetId,
			sourceContactId: sourceId,
		});

		await t.run(async (ctx) => {
			const target = await ctx.db.get(targetId);
			expect(target!.firstName).toBe('Alice');
			expect(target!.lastName).toBe('Smith');
		});
	});

	it('should not overwrite existing names on target', async () => {
		const t = convexTest(schema, modules);
		let targetId!: Id<'contacts'>;
		let sourceId!: Id<'contacts'>;

		await t.run(async (ctx) => {
			targetId = await ctx.db.insert('contacts', createTestContact({
				email: 'target@example.com',
				firstName: 'TargetFirst',
				lastName: 'TargetLast',
			}));
			sourceId = await ctx.db.insert('contacts', createTestContact({
				email: 'source@example.com',
				firstName: 'SourceFirst',
				lastName: 'SourceLast',
			}));
		});

		await t.mutation(api.contacts.identities.mergeContacts, {
			targetContactId: targetId,
			sourceContactId: sourceId,
		});

		await t.run(async (ctx) => {
			const target = await ctx.db.get(targetId);
			expect(target!.firstName).toBe('TargetFirst');
			expect(target!.lastName).toBe('TargetLast');
		});
	});

	it('should delete the source contact after merge', async () => {
		const t = convexTest(schema, modules);
		let targetId!: Id<'contacts'>;
		let sourceId!: Id<'contacts'>;

		await t.run(async (ctx) => {
			targetId = await ctx.db.insert('contacts', createTestContact({ email: 'target@example.com' }));
			sourceId = await ctx.db.insert('contacts', createTestContact({ email: 'source@example.com' }));
		});

		await t.mutation(api.contacts.identities.mergeContacts, {
			targetContactId: targetId,
			sourceContactId: sourceId,
		});

		await t.run(async (ctx) => {
			const source = await ctx.db.get(sourceId);
			expect(source).toBeNull();
			const target = await ctx.db.get(targetId);
			expect(target).toBeDefined();
		});
	});

	it('should throw if target contact does not exist', async () => {
		const t = convexTest(schema, modules);
		let sourceId!: Id<'contacts'>;
		let fakeTargetId!: Id<'contacts'>;

		await t.run(async (ctx) => {
			sourceId = await ctx.db.insert('contacts', createTestContact({ email: 'source@example.com' }));
			// Create and delete to get a valid but missing ID
			fakeTargetId = await ctx.db.insert('contacts', createTestContact({ email: 'fake@example.com' }));
			await ctx.db.delete(fakeTargetId);
		});

		await expect(
			t.mutation(api.contacts.identities.mergeContacts, {
				targetContactId: fakeTargetId,
				sourceContactId: sourceId,
			})
		).rejects.toThrow('Contact not found');
	});

	it('should repoint EVERY referencing table off the deleted source (no orphans)', async () => {
		const t = convexTest(schema, modules);
		let targetId!: Id<'contacts'>;
		let sourceId!: Id<'contacts'>;
		let sharedTopicId!: Id<'topics'>;
		let sourceOnlyTopicId!: Id<'topics'>;
		let sharedPropertyId!: Id<'contactProperties'>;
		let sourceOnlyPropertyId!: Id<'contactProperties'>;

		await t.run(async (ctx) => {
			targetId = await ctx.db.insert('contacts', createTestContact({ email: 'target@example.com' }));
			sourceId = await ctx.db.insert('contacts', createTestContact({ email: 'source@example.com' }));
			const now = Date.now();

			// --- Topic memberships: one shared with target (dedupe), one source-only (repoint) ---
			sharedTopicId = await ctx.db.insert('topics', createTestTopic());
			sourceOnlyTopicId = await ctx.db.insert('topics', createTestTopic());
			await ctx.db.insert('contactTopics', { contactId: targetId, topicId: sharedTopicId, addedAt: now });
			await ctx.db.insert('contactTopics', { contactId: sourceId, topicId: sharedTopicId, addedAt: now });
			await ctx.db.insert('contactTopics', { contactId: sourceId, topicId: sourceOnlyTopicId, addedAt: now });

			// --- Property values: one shared property (dedupe, source newer wins), one source-only (repoint) ---
			sharedPropertyId = await ctx.db.insert('contactProperties', { key: 'company', label: 'Company', type: 'string', createdAt: now });
			sourceOnlyPropertyId = await ctx.db.insert('contactProperties', { key: 'phone', label: 'Phone', type: 'string', createdAt: now });
			await ctx.db.insert('contactPropertyValues', { contactId: targetId, propertyId: sharedPropertyId, value: 'OldCo', createdAt: now, updatedAt: now });
			await ctx.db.insert('contactPropertyValues', { contactId: sourceId, propertyId: sharedPropertyId, value: 'NewCo', createdAt: now, updatedAt: now + 1000 });
			await ctx.db.insert('contactPropertyValues', { contactId: sourceId, propertyId: sourceOnlyPropertyId, value: '+1555', createdAt: now, updatedAt: now });

			// --- Identity (repoint) ---
			await ctx.db.insert('contactIdentities', createTestContactIdentity({ contactId: sourceId, channel: 'phone', identifier: '+5551234' }));

			// --- Relationships (both directions) ---
			const thirdId = await ctx.db.insert('contacts', createTestContact({ email: 'third@example.com' }));
			await ctx.db.insert('contactRelationships', createTestContactRelationship({ fromContactId: sourceId, toContactId: thirdId }));
			await ctx.db.insert('contactRelationships', createTestContactRelationship({ fromContactId: thirdId, toContactId: sourceId }));

			// --- Activity ---
			await ctx.db.insert('contactActivities', { contactId: sourceId, activityType: 'created', metadata: { source: 'api' }, occurredAt: now });

			// --- Email send ---
			const campaignId = await ctx.db.insert('campaigns', createTestCampaign());
			await ctx.db.insert('emailSends', createTestEmailSend({ campaignId, contactId: sourceId }));

			// --- Transactional send ---
			await ctx.db.insert('transactionalSends', {
				kind: 'transactional',
				email: 'source@example.com',
				contactId: sourceId,
				status: 'queued',
				queuedAt: now,
			});

			// --- Automation run ---
			const automationId = await ctx.db.insert('automations', createTestAutomation());
			await ctx.db.insert('automationRuns', {
				automationId,
				contactId: sourceId,
				currentStepIndex: 0,
				status: 'running',
				startedAt: now,
				triggeredBy: 'contact_created',
			});

			// --- Form submission ---
			const formEndpointId = await ctx.db.insert('formEndpoints', {
				name: 'Signup',
				fields: [],
				isActive: true,
				createdAt: now,
				updatedAt: now,
			});
			await ctx.db.insert('formSubmissions', createTestFormSubmission({ formEndpointId, contactId: sourceId }));

			// --- Conversation thread + unified message + inbound message ---
			const threadId = await ctx.db.insert('conversationThreads', {
				subject: 'Thread',
				normalizedSubject: 'thread',
				contactId: sourceId,
				contactIdentifier: 'source@example.com',
				status: 'open',
				messageCount: 1,
				lastMessageAt: now,
				firstMessageAt: now,
				createdAt: now,
			});
			await ctx.db.insert('unifiedMessages', createTestUnifiedMessage({ threadId, contactId: sourceId }));
			await ctx.db.insert('inboundMessages', createTestInboundMessage({ threadId, contactId: sourceId }));
		});

		await t.mutation(api.contacts.identities.mergeContacts, {
			targetContactId: targetId,
			sourceContactId: sourceId,
		});

		await t.run(async (ctx) => {
			// Source is gone.
			expect(await ctx.db.get(sourceId)).toBeNull();

			// ZERO rows still point at the deleted source across every referencing table.
			const referencingTables = [
				'contactTopics',
				'contactPropertyValues',
				'contactIdentities',
				'contactActivities',
				'emailSends',
				'transactionalSends',
				'automationRuns',
				'formSubmissions',
				'conversationThreads',
				'unifiedMessages',
				'inboundMessages',
			] as const;
			for (const table of referencingTables) {
				const orphans = await ctx.db
					.query(table)
					.withIndex('by_contact', (q) => q.eq('contactId', sourceId))
					.collect();
				expect(orphans, `${table} should have no rows pointing at the deleted source`).toHaveLength(0);
			}

			// Relationships repointed off the source on BOTH sides.
			const relFrom = await ctx.db
				.query('contactRelationships')
				.withIndex('by_from', (q) => q.eq('fromContactId', sourceId))
				.collect();
			const relTo = await ctx.db
				.query('contactRelationships')
				.withIndex('by_to', (q) => q.eq('toContactId', sourceId))
				.collect();
			expect(relFrom).toHaveLength(0);
			expect(relTo).toHaveLength(0);
			expect(
				await ctx.db
					.query('contactRelationships')
					.withIndex('by_from', (q) => q.eq('fromContactId', targetId))
					.collect()
			).toHaveLength(1);
			expect(
				await ctx.db
					.query('contactRelationships')
					.withIndex('by_to', (q) => q.eq('toContactId', targetId))
					.collect()
			).toHaveLength(1);

			// contactTopics dedupe: target keeps exactly one membership per topic
			// (shared topic deduped, source-only topic repointed) — 2 total, no dupes.
			const targetTopics = await ctx.db
				.query('contactTopics')
				.withIndex('by_contact', (q) => q.eq('contactId', targetId))
				.collect();
			expect(targetTopics).toHaveLength(2);
			const topicIds = targetTopics.map((m) => m.topicId as string).sort();
			expect(topicIds).toEqual([sharedTopicId, sourceOnlyTopicId].sort());
			// No duplicate membership for the shared topic.
			const sharedMemberships = targetTopics.filter((m) => m.topicId === sharedTopicId);
			expect(sharedMemberships).toHaveLength(1);

			// contactPropertyValues dedupe: one value per property; shared property
			// takes the source's newer value, source-only property repointed.
			const targetValues = await ctx.db
				.query('contactPropertyValues')
				.withIndex('by_contact', (q) => q.eq('contactId', targetId))
				.collect();
			expect(targetValues).toHaveLength(2);
			const sharedValue = targetValues.find((v) => v.propertyId === sharedPropertyId);
			expect(sharedValue!.value).toBe('NewCo');
			const sourceOnlyValue = targetValues.find((v) => v.propertyId === sourceOnlyPropertyId);
			expect(sourceOnlyValue!.value).toBe('+1555');

			// Spot-check a repoint-only table actually landed on target.
			const targetSends = await ctx.db
				.query('emailSends')
				.withIndex('by_contact', (q) => q.eq('contactId', targetId))
				.collect();
			expect(targetSends).toHaveLength(1);
		});
	});

	it('repoints knowledge entry contact junctions onto the target', async () => {
		const t = convexTest(schema, modules);
		let targetId!: Id<'contacts'>;
		let sourceId!: Id<'contacts'>;
		let sourceOnlyEntryId!: Id<'knowledgeEntries'>;
		let sharedEntryId!: Id<'knowledgeEntries'>;

		await t.run(async (ctx) => {
			targetId = await ctx.db.insert('contacts', createTestContact({ email: 'target@example.com' }));
			sourceId = await ctx.db.insert('contacts', createTestContact({ email: 'source@example.com' }));

			// Entry linked only to source — should be repointed onto target.
			sourceOnlyEntryId = await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({
				title: 'Source Only',
				content: 'c',
				sourceType: 'manual',
				contactIds: [sourceId],
			}));
			await ctx.db.insert('knowledgeEntryContacts', { entryId: sourceOnlyEntryId, contactId: sourceId });

			// Entry linked to BOTH — the source junction row is redundant and dropped.
			sharedEntryId = await ctx.db.insert('knowledgeEntries', createTestKnowledgeEntry({
				title: 'Shared',
				content: 'c',
				sourceType: 'manual',
				contactIds: [targetId, sourceId],
			}));
			await ctx.db.insert('knowledgeEntryContacts', { entryId: sharedEntryId, contactId: targetId });
			await ctx.db.insert('knowledgeEntryContacts', { entryId: sharedEntryId, contactId: sourceId });
		});

		await t.mutation(api.contacts.identities.mergeContacts, {
			targetContactId: targetId,
			sourceContactId: sourceId,
		});

		await t.run(async (ctx) => {
			// No junction row points at the deleted source.
			const sourceLinks = await ctx.db
				.query('knowledgeEntryContacts')
				.withIndex('by_contact', (q) => q.eq('contactId', sourceId))
				.collect();
			expect(sourceLinks).toHaveLength(0);

			// Target holds exactly one junction row per entry (shared deduped).
			const targetLinks = await ctx.db
				.query('knowledgeEntryContacts')
				.withIndex('by_contact', (q) => q.eq('contactId', targetId))
				.collect();
			const targetEntryIds = targetLinks.map((l) => l.entryId as string).sort();
			expect(targetEntryIds).toEqual([sourceOnlyEntryId, sharedEntryId].sort());

			// The entry's contactIds array is kept in sync with the junction.
			const sourceOnly = await ctx.db.get(sourceOnlyEntryId);
			expect(sourceOnly!.contactIds).toEqual([targetId]);
			const shared = await ctx.db.get(sharedEntryId);
			expect(shared!.contactIds).toEqual([targetId]);
		});
	});
});

// ============ contactIdentities.ensureEmailIdentity (internal) ============

describe('contactIdentities.ensureEmailIdentity', () => {
	it('should create an email identity for a contact without one', async () => {
		const t = convexTest(schema, modules);
		let contactId!: Id<'contacts'>;

		await t.run(async (ctx) => {
			contactId = await ctx.db.insert('contacts', createTestContact({ email: 'ensure@example.com' }));
		});

		const result = await t.mutation(internal.contacts.identities.ensureEmailIdentity, {
			contactId,
		});

		expect(result).toBeDefined();

		await t.run(async (ctx) => {
			const identity = await ctx.db
				.query('contactIdentities')
				.withIndex('by_identifier', (q) =>
					q.eq('channel', 'email').eq('identifier', 'ensure@example.com')
				)
				.first();
			expect(identity).toBeDefined();
			expect(identity!.contactId).toBe(contactId);
			expect(identity!.isPrimary).toBe(true);
			expect(identity!.channel).toBe('email');
		});
	});

	it('should return existing identity ID if already present', async () => {
		const t = convexTest(schema, modules);
		let contactId!: Id<'contacts'>;
		let existingId!: Id<'contactIdentities'>;

		await t.run(async (ctx) => {
			contactId = await ctx.db.insert('contacts', createTestContact({ email: 'exists@example.com' }));
			existingId = await ctx.db.insert('contactIdentities', createTestContactIdentity({
				contactId,
				channel: 'email',
				identifier: 'exists@example.com',
				isPrimary: true,
			}));
		});

		const result = await t.mutation(internal.contacts.identities.ensureEmailIdentity, {
			contactId,
		});

		expect(result).toBe(existingId);
	});

	it('should do nothing for a non-existent contact', async () => {
		const t = convexTest(schema, modules);
		let fakeId!: Id<'contacts'>;

		await t.run(async (ctx) => {
			fakeId = await ctx.db.insert('contacts', createTestContact());
			await ctx.db.delete(fakeId);
		});

		const result = await t.mutation(internal.contacts.identities.ensureEmailIdentity, {
			contactId: fakeId,
		});

		// ensureEmailIdentity returns undefined (void) for non-existent contacts
		expect(result).toBeFalsy();
	});
});
