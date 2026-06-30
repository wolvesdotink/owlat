import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import { createTestTopic, createTestContact, createTestCampaign, createTestEmailSend } from './factories';
import type { Id } from '../_generated/dataModel';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		requireOrgPermission: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		requireAuthenticatedIdentity: vi.fn().mockResolvedValue({ subject: 'test-user', issuer: 'test', tokenIdentifier: 'test|test-user' }),
	};
});

const modules = import.meta.glob('../**/*.*s');

// ============ topics.create ============

describe('topics.create', () => {
	it('should create a topic with name, description, and requireDoubleOptIn', async () => {
		const t = convexTest(schema, modules);

		const topicId = await t.mutation(api.topics.topics.create, {
			name: 'Newsletter Subscribers',
			description: 'Weekly newsletter list',
			requireDoubleOptIn: true,
		});

		expect(topicId).toBeDefined();

		await t.run(async (ctx) => {
			const topic = await ctx.db.get(topicId);
			expect(topic).toBeDefined();
			expect(topic!.name).toBe('Newsletter Subscribers');
			expect(topic!.description).toBe('Weekly newsletter list');
			expect(topic!.requireDoubleOptIn).toBe(true);
			expect(topic!.createdAt).toBeGreaterThan(0);
		});
	});

	it('should return the topic ID', async () => {
		const t = convexTest(schema, modules);

		const topicId = await t.mutation(api.topics.topics.create, {
			name: 'Test List',
		});

		expect(typeof topicId).toBe('string');
		expect(topicId).toBeTruthy();
	});
});

// ============ topics.get ============

describe('topics.get', () => {
	it('should return topic with contactCount', async () => {
		const t = convexTest(schema, modules);
		let topicId: Id<'topics'>;

		await t.run(async (ctx) => {
			topicId = await ctx.db.insert('topics', createTestTopic({ name: 'My List' }));
			const contactId = await ctx.db.insert('contacts', createTestContact());
			await ctx.db.insert('contactTopics', {
				contactId,
				topicId: topicId,
				addedAt: Date.now(),
			});
		});

		const topic = await t.query(api.topics.topics.get, { topicId: topicId! });

		expect(topic).toBeDefined();
		expect(topic!.name).toBe('My List');
		expect(topic!.contactCount).toBe(1);
	});

	it('should return null for non-existent topic', async () => {
		const t = convexTest(schema, modules);
		let topicId: Id<'topics'>;

		await t.run(async (ctx) => {
			topicId = await ctx.db.insert('topics', createTestTopic());
			await ctx.db.delete(topicId);
		});

		const topic = await t.query(api.topics.topics.get, { topicId: topicId! });
		expect(topic).toBeNull();
	});
});

// ============ topics.update ============

describe('topics.update', () => {
	it('should update name, description, and requireDoubleOptIn (partial updates)', async () => {
		const t = convexTest(schema, modules);
		let topicId: Id<'topics'>;

		await t.run(async (ctx) => {
			topicId = await ctx.db.insert('topics', createTestTopic({
				name: 'Original',
				description: 'Original desc',
				requireDoubleOptIn: false,
			}));
		});

		// Partial update: only name
		await t.mutation(api.topics.topics.update, {
			topicId: topicId!,
			name: 'Updated Name',
		});

		await t.run(async (ctx) => {
			const topic = await ctx.db.get(topicId!);
			expect(topic!.name).toBe('Updated Name');
			expect(topic!.description).toBe('Original desc');
			expect(topic!.requireDoubleOptIn).toBe(false);
		});

		// Partial update: description and requireDoubleOptIn
		await t.mutation(api.topics.topics.update, {
			topicId: topicId!,
			description: 'New description',
			requireDoubleOptIn: true,
		});

		await t.run(async (ctx) => {
			const topic = await ctx.db.get(topicId!);
			expect(topic!.name).toBe('Updated Name');
			expect(topic!.description).toBe('New description');
			expect(topic!.requireDoubleOptIn).toBe(true);
		});
	});

	it('should throw for non-existent topic', async () => {
		const t = convexTest(schema, modules);
		let topicId: Id<'topics'>;

		await t.run(async (ctx) => {
			topicId = await ctx.db.insert('topics', createTestTopic());
			await ctx.db.delete(topicId);
		});

		await expect(
			t.mutation(api.topics.topics.update, {
				topicId: topicId!,
				name: 'Should Fail',
			})
		).rejects.toThrow(/Topic not found/);
	});
});

// ============ topics.remove ============

describe('topics.remove', () => {
	it('should delete topic and all memberships (cascade)', async () => {
		const t = convexTest(schema, modules);
		let topicId: Id<'topics'>;
		let membershipId1: Id<'contactTopics'>;
		let membershipId2: Id<'contactTopics'>;

		await t.run(async (ctx) => {
			topicId = await ctx.db.insert('topics', createTestTopic());
			const contact1 = await ctx.db.insert('contacts', createTestContact());
			const contact2 = await ctx.db.insert('contacts', createTestContact());
			membershipId1 = await ctx.db.insert('contactTopics', {
				contactId: contact1,
				topicId: topicId,
				addedAt: Date.now(),
			});
			membershipId2 = await ctx.db.insert('contactTopics', {
				contactId: contact2,
				topicId: topicId,
				addedAt: Date.now(),
			});
		});

		await t.mutation(api.topics.topics.remove, { topicId: topicId! });

		await t.run(async (ctx) => {
			expect(await ctx.db.get(topicId!)).toBeNull();
			expect(await ctx.db.get(membershipId1!)).toBeNull();
			expect(await ctx.db.get(membershipId2!)).toBeNull();
		});
	});

	it('should throw for non-existent topic', async () => {
		const t = convexTest(schema, modules);
		let topicId: Id<'topics'>;

		await t.run(async (ctx) => {
			topicId = await ctx.db.insert('topics', createTestTopic());
			await ctx.db.delete(topicId);
		});

		await expect(
			t.mutation(api.topics.topics.remove, { topicId: topicId! })
		).rejects.toThrow(/Topic not found/);
	});
});

// ============ topics.addContact ============

describe('topics.addContact', () => {
	it('should add contact to topic (no DOI)', async () => {
		const t = convexTest(schema, modules);
		let topicId: Id<'topics'>;
		let contactId: Id<'contacts'>;

		await t.run(async (ctx) => {
			topicId = await ctx.db.insert('topics', createTestTopic({ requireDoubleOptIn: false }));
			contactId = await ctx.db.insert('contacts', createTestContact());
		});

		const result = await t.mutation(api.topics.topics.addContact, {
			topicId: topicId!,
			contactId: contactId!,
		});

		expect(result.membershipId).toBeDefined();
		expect(result.doiStatus).toBe('not_required');

		await t.run(async (ctx) => {
			const membership = await ctx.db.get(result.membershipId);
			expect(membership).toBeDefined();
			expect(membership!.contactId).toBe(contactId!);
			expect(membership!.topicId).toBe(topicId!);
		});
	});

	it('should return existing membership if already member (idempotent)', async () => {
		const t = convexTest(schema, modules);
		let topicId: Id<'topics'>;
		let contactId: Id<'contacts'>;

		await t.run(async (ctx) => {
			topicId = await ctx.db.insert('topics', createTestTopic({ requireDoubleOptIn: false }));
			contactId = await ctx.db.insert('contacts', createTestContact());
		});

		const first = await t.mutation(api.topics.topics.addContact, {
			topicId: topicId!,
			contactId: contactId!,
		});

		const second = await t.mutation(api.topics.topics.addContact, {
			topicId: topicId!,
			contactId: contactId!,
		});

		expect(second.membershipId).toBe(first.membershipId);
		expect(second.doiStatus).toBe('not_required');
	});

	it('should set contact DOI status to pending when topic requires DOI', async () => {
		const t = convexTest(schema, modules);
		let topicId: Id<'topics'>;
		let contactId: Id<'contacts'>;

		await t.run(async (ctx) => {
			topicId = await ctx.db.insert('topics', createTestTopic({ requireDoubleOptIn: true }));
			contactId = await ctx.db.insert('contacts', createTestContact());
		});

		const result = await t.mutation(api.topics.topics.addContact, {
			topicId: topicId!,
			contactId: contactId!,
		});

		expect(result.membershipId).toBeDefined();
		expect(result.doiStatus).toBe('pending');

		// Token should be on the contact, not the membership
		await t.run(async (ctx) => {
			const contact = await ctx.db.get(contactId!);
			expect(contact!.doiStatus).toBe('pending');
			expect(contact!.doiConfirmationToken).toBeDefined();
			expect(contact!.doiTokenExpiresAt).toBeGreaterThan(0);
		});
	});

	it('should not resend DOI email if contact is already pending', async () => {
		const t = convexTest(schema, modules);
		let _topicId1: Id<'topics'>;
		let topicId2: Id<'topics'>;
		let contactId: Id<'contacts'>;

		await t.run(async (ctx) => {
			_topicId1 = await ctx.db.insert('topics', createTestTopic({ requireDoubleOptIn: true }));
			topicId2 = await ctx.db.insert('topics', createTestTopic({ requireDoubleOptIn: true }));
			contactId = await ctx.db.insert('contacts', createTestContact({
				doiStatus: 'pending',
				doiConfirmationToken: 'existing-token',
				doiTokenExpiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
			}));
		});

		// Adding to a second DOI topic should not change the existing pending token
		const result = await t.mutation(api.topics.topics.addContact, {
			topicId: topicId2!,
			contactId: contactId!,
		});

		expect(result.doiStatus).toBe('pending');

		await t.run(async (ctx) => {
			const contact = await ctx.db.get(contactId!);
			expect(contact!.doiConfirmationToken).toBe('existing-token');
		});
	});

	it('should subscribe immediately if contact is already DOI-confirmed', async () => {
		const t = convexTest(schema, modules);
		let topicId: Id<'topics'>;
		let contactId: Id<'contacts'>;

		await t.run(async (ctx) => {
			topicId = await ctx.db.insert('topics', createTestTopic({ requireDoubleOptIn: true }));
			contactId = await ctx.db.insert('contacts', createTestContact({
				doiStatus: 'confirmed',
				doiConfirmedAt: Date.now(),
			}));
		});

		const result = await t.mutation(api.topics.topics.addContact, {
			topicId: topicId!,
			contactId: contactId!,
		});

		// Status reflects the contact's confirmed DOI
		expect(result.doiStatus).toBe('confirmed');
		expect(result.membershipId).toBeDefined();
	});

	it('should return membershipId and doiStatus', async () => {
		const t = convexTest(schema, modules);
		let topicId: Id<'topics'>;
		let contactId: Id<'contacts'>;

		await t.run(async (ctx) => {
			topicId = await ctx.db.insert('topics', createTestTopic({ requireDoubleOptIn: true }));
			contactId = await ctx.db.insert('contacts', createTestContact());
		});

		const result = await t.mutation(api.topics.topics.addContact, {
			topicId: topicId!,
			contactId: contactId!,
		});

		expect(result).toHaveProperty('membershipId');
		expect(result).toHaveProperty('doiStatus');
	});
});

// ============ topics.removeContact ============

describe('topics.removeContact', () => {
	it('should remove contact from topic', async () => {
		const t = convexTest(schema, modules);
		let topicId: Id<'topics'>;
		let contactId: Id<'contacts'>;
		let membershipId: Id<'contactTopics'>;

		await t.run(async (ctx) => {
			topicId = await ctx.db.insert('topics', createTestTopic({ requireDoubleOptIn: false }));
			contactId = await ctx.db.insert('contacts', createTestContact());
			membershipId = await ctx.db.insert('contactTopics', {
				contactId,
				topicId: topicId,
				addedAt: Date.now(),
			});
		});

		await t.mutation(api.topics.topics.removeContact, {
			topicId: topicId!,
			contactId: contactId!,
		});

		await t.run(async (ctx) => {
			expect(await ctx.db.get(membershipId!)).toBeNull();
		});
	});

	it('should succeed silently if not a member', async () => {
		const t = convexTest(schema, modules);
		let topicId: Id<'topics'>;
		let contactId: Id<'contacts'>;

		await t.run(async (ctx) => {
			topicId = await ctx.db.insert('topics', createTestTopic());
			contactId = await ctx.db.insert('contacts', createTestContact());
		});

		// Should not throw
		await t.mutation(api.topics.topics.removeContact, {
			topicId: topicId!,
			contactId: contactId!,
		});
	});
});

// ============ topics.addContacts (batch) ============

describe('topics.addContacts', () => {
	it('should add multiple contacts', async () => {
		const t = convexTest(schema, modules);
		let topicId: Id<'topics'>;
		let contactId1: Id<'contacts'>;
		let contactId2: Id<'contacts'>;
		let contactId3: Id<'contacts'>;

		await t.run(async (ctx) => {
			topicId = await ctx.db.insert('topics', createTestTopic({ requireDoubleOptIn: false }));
			contactId1 = await ctx.db.insert('contacts', createTestContact());
			contactId2 = await ctx.db.insert('contacts', createTestContact());
			contactId3 = await ctx.db.insert('contacts', createTestContact());
		});

		const addedIds = await t.mutation(api.topics.bulk.addContacts, {
			topicId: topicId!,
			contactIds: [contactId1!, contactId2!, contactId3!],
		});

		expect(addedIds).toHaveLength(3);

		await t.run(async (ctx) => {
			const memberships = await ctx.db
				.query('contactTopics')
				.withIndex('by_topic', (q) => q.eq('topicId', topicId!))
				.collect();
			expect(memberships).toHaveLength(3);
		});
	});

	it('should skip already-existing members', async () => {
		const t = convexTest(schema, modules);
		let topicId: Id<'topics'>;
		let contactId1: Id<'contacts'>;
		let contactId2: Id<'contacts'>;

		await t.run(async (ctx) => {
			topicId = await ctx.db.insert('topics', createTestTopic({ requireDoubleOptIn: false }));
			contactId1 = await ctx.db.insert('contacts', createTestContact());
			contactId2 = await ctx.db.insert('contacts', createTestContact());

			// Pre-add contactId1
			await ctx.db.insert('contactTopics', {
				contactId: contactId1,
				topicId: topicId,
				addedAt: Date.now(),
			});
		});

		const addedIds = await t.mutation(api.topics.bulk.addContacts, {
			topicId: topicId!,
			contactIds: [contactId1!, contactId2!],
		});

		// Only contactId2 should be newly added
		expect(addedIds).toHaveLength(1);
	});

	it('should return only newly added IDs', async () => {
		const t = convexTest(schema, modules);
		let topicId: Id<'topics'>;
		let contactId1: Id<'contacts'>;
		let contactId2: Id<'contacts'>;

		await t.run(async (ctx) => {
			topicId = await ctx.db.insert('topics', createTestTopic({ requireDoubleOptIn: false }));
			contactId1 = await ctx.db.insert('contacts', createTestContact());
			contactId2 = await ctx.db.insert('contacts', createTestContact());
		});

		// Add first batch
		const firstBatch = await t.mutation(api.topics.bulk.addContacts, {
			topicId: topicId!,
			contactIds: [contactId1!],
		});
		expect(firstBatch).toHaveLength(1);

		// Add second batch (overlapping)
		const secondBatch = await t.mutation(api.topics.bulk.addContacts, {
			topicId: topicId!,
			contactIds: [contactId1!, contactId2!],
		});
		expect(secondBatch).toHaveLength(1); // Only contactId2 is new
	});
});

// ============ topics.removeContacts (batch) ============

describe('topics.removeContacts', () => {
	it('should remove multiple contacts', async () => {
		const t = convexTest(schema, modules);
		let topicId: Id<'topics'>;
		let contactId1: Id<'contacts'>;
		let contactId2: Id<'contacts'>;

		await t.run(async (ctx) => {
			topicId = await ctx.db.insert('topics', createTestTopic());
			contactId1 = await ctx.db.insert('contacts', createTestContact());
			contactId2 = await ctx.db.insert('contacts', createTestContact());
			await ctx.db.insert('contactTopics', {
				contactId: contactId1,
				topicId: topicId,
				addedAt: Date.now(),
			});
			await ctx.db.insert('contactTopics', {
				contactId: contactId2,
				topicId: topicId,
				addedAt: Date.now(),
			});
		});

		await t.mutation(api.topics.bulk.removeContacts, {
			topicId: topicId!,
			contactIds: [contactId1!, contactId2!],
		});

		await t.run(async (ctx) => {
			const memberships = await ctx.db
				.query('contactTopics')
				.withIndex('by_topic', (q) => q.eq('topicId', topicId!))
				.collect();
			expect(memberships).toHaveLength(0);
		});
	});

	it('should succeed silently for non-members', async () => {
		const t = convexTest(schema, modules);
		let topicId: Id<'topics'>;
		let contactId1: Id<'contacts'>;
		let contactId2: Id<'contacts'>;

		await t.run(async (ctx) => {
			topicId = await ctx.db.insert('topics', createTestTopic());
			contactId1 = await ctx.db.insert('contacts', createTestContact());
			contactId2 = await ctx.db.insert('contacts', createTestContact());

			// Only add contactId1
			await ctx.db.insert('contactTopics', {
				contactId: contactId1,
				topicId: topicId,
				addedAt: Date.now(),
			});
		});

		// Remove both (contactId2 was never a member)
		await t.mutation(api.topics.bulk.removeContacts, {
			topicId: topicId!,
			contactIds: [contactId1!, contactId2!],
		});

		await t.run(async (ctx) => {
			const memberships = await ctx.db
				.query('contactTopics')
				.withIndex('by_topic', (q) => q.eq('topicId', topicId!))
				.collect();
			expect(memberships).toHaveLength(0);
		});
	});
});

// ============ topics.confirmDoi ============

describe('topics.confirmDoi', () => {
	it('should confirm pending DOI on the contact and unlock all DOI topic subscriptions', async () => {
		const t = convexTest(schema, modules);
		let topicId1: Id<'topics'>;
		let topicId2: Id<'topics'>;
		let contactId: Id<'contacts'>;
		let doiToken: string;

		await t.run(async (ctx) => {
			topicId1 = await ctx.db.insert('topics', createTestTopic({ requireDoubleOptIn: true }));
			topicId2 = await ctx.db.insert('topics', createTestTopic({ requireDoubleOptIn: true }));
			contactId = await ctx.db.insert('contacts', createTestContact({
				email: 'doi@example.com',
				doiStatus: 'pending',
				doiConfirmationToken: 'test-doi-token-123',
				doiTokenExpiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
			}));
			// Subscribe contact to both DOI topics
			await ctx.db.insert('contactTopics', {
				contactId,
				topicId: topicId1,
				addedAt: Date.now(),
			});
			await ctx.db.insert('contactTopics', {
				contactId,
				topicId: topicId2,
				addedAt: Date.now(),
			});
			doiToken = 'test-doi-token-123';
		});

		const result = await t.mutation(internal.topics.topics.confirmDoi, {
			token: doiToken!,
		});

		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.contactEmail).toBe('doi@example.com');
		}

		await t.run(async (ctx) => {
			const contact = await ctx.db.get(contactId!);
			expect(contact!.doiStatus).toBe('confirmed');
			expect(contact!.doiConfirmedAt).toBeGreaterThan(0);
			expect(contact!.doiConfirmationToken).toBeUndefined();
		});
	});

	it('should return success with alreadyConfirmed for already confirmed contact', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert('contacts', createTestContact({
				doiStatus: 'confirmed',
				doiConfirmationToken: 'already-confirmed-token',
				doiConfirmedAt: Date.now(),
			}));
		});

		const result = await t.mutation(internal.topics.topics.confirmDoi, {
			token: 'already-confirmed-token',
		});

		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.alreadyConfirmed).toBe(true);
		}
	});

	it('should return success false for invalid token', async () => {
		const t = convexTest(schema, modules);

		const result = await t.mutation(internal.topics.topics.confirmDoi, {
			token: 'nonexistent-token',
		});

		expect(result.success).toBe(false);
	});
});

// ============ topics.getContactByDoiToken ============

describe('topics.getContactByDoiToken', () => {
	it('should return contact info for valid token', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert('contacts', createTestContact({
				email: 'token-test@example.com',
				firstName: 'Token',
				doiStatus: 'pending',
				doiConfirmationToken: 'valid-doi-token',
				doiTokenExpiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
			}));
		});

		const result = await t.query(internal.topics.topics.getContactByDoiToken, {
			token: 'valid-doi-token',
		});

		expect(result).toBeDefined();
		expect(result!.contactEmail).toBe('token-test@example.com');
		expect(result!.contactFirstName).toBe('Token');
		expect(result!.doiStatus).toBe('pending');
	});

	it('should return null for invalid token', async () => {
		const t = convexTest(schema, modules);

		const result = await t.query(internal.topics.topics.getContactByDoiToken, {
			token: 'invalid-token',
		});

		expect(result).toBeNull();
	});
});

// ============ topics.getContacts ============

describe('topics.getContacts', () => {
	it('should return contacts with addedAt metadata', async () => {
		const t = convexTest(schema, modules);
		let topicId: Id<'topics'>;
		const addedAt = Date.now();

		await t.run(async (ctx) => {
			topicId = await ctx.db.insert('topics', createTestTopic());
			const contactId = await ctx.db.insert('contacts', createTestContact({
				email: 'member@example.com',
				firstName: 'Test',
			}));
			await ctx.db.insert('contactTopics', {
				contactId,
				topicId: topicId,
				addedAt,
			});
		});

		const result = await t.query(api.topics.topics.getContacts, {
			topicId: topicId!,
			paginationOpts: { numItems: 50, cursor: null },
		});

		expect(result.page).toHaveLength(1);
		expect(result.page[0]!.email).toBe('member@example.com');
		expect(result.page[0]!.firstName).toBe('Test');
		expect(result.page[0]!.addedAt).toBe(addedAt);
	});

	it('should filter out deleted contacts', async () => {
		const t = convexTest(schema, modules);
		let topicId: Id<'topics'>;

		await t.run(async (ctx) => {
			topicId = await ctx.db.insert('topics', createTestTopic());
			const activeContact = await ctx.db.insert('contacts', createTestContact({ email: 'active@example.com' }));
			const deletedContact = await ctx.db.insert('contacts', createTestContact({ email: 'deleted@example.com' }));

			await ctx.db.insert('contactTopics', {
				contactId: activeContact,
				topicId: topicId,
				addedAt: Date.now(),
			});
			await ctx.db.insert('contactTopics', {
				contactId: deletedContact,
				topicId: topicId,
				addedAt: Date.now(),
			});

			// Delete the second contact
			await ctx.db.delete(deletedContact);
		});

		const result = await t.query(api.topics.topics.getContacts, {
			topicId: topicId!,
			paginationOpts: { numItems: 50, cursor: null },
		});

		expect(result.page).toHaveLength(1);
		expect(result.page[0]!.email).toBe('active@example.com');
	});
});

// ============ topics.getTopicsForContact ============

describe('topics.getTopicsForContact', () => {
	it('should return all topics for a contact with addedAt metadata', async () => {
		const t = convexTest(schema, modules);
		let contactId: Id<'contacts'>;
		const now = Date.now();

		await t.run(async (ctx) => {
			contactId = await ctx.db.insert('contacts', createTestContact());
			const topic1 = await ctx.db.insert('topics', createTestTopic({ name: 'List A' }));
			const topic2 = await ctx.db.insert('topics', createTestTopic({ name: 'List B' }));

			await ctx.db.insert('contactTopics', {
				contactId,
				topicId: topic1,
				addedAt: now,
			});
			await ctx.db.insert('contactTopics', {
				contactId,
				topicId: topic2,
				addedAt: now + 1000,
			});
		});

		const topics = await t.query(api.topics.topics.getTopicsForContact, {
			contactId: contactId!,
		});

		expect(topics).toHaveLength(2);
		const names = topics.map((l: { name: string }) => l.name).sort();
		expect(names).toEqual(['List A', 'List B']);
	});
});

// ============ topics.getContactInTopicDetails ============

describe('topics.getContactInTopicDetails', () => {
	it('should return full details including email history and engagement stats', async () => {
		const t = convexTest(schema, modules);
		let topicId: Id<'topics'>;
		let contactId: Id<'contacts'>;
		const now = Date.now();

		await t.run(async (ctx) => {
			topicId = await ctx.db.insert('topics', createTestTopic({
				name: 'Analytics List',
				description: 'For testing',
			}));
			contactId = await ctx.db.insert('contacts', createTestContact({
				email: 'analytics@example.com',
				firstName: 'Ana',
				lastName: 'Lytics',
			}));
			await ctx.db.insert('contactTopics', {
				contactId,
				topicId: topicId,
				addedAt: now,
			});

			// Create a campaign targeting this topic
			const campaignId = await ctx.db.insert('campaigns', createTestCampaign({
				name: 'Test Campaign',
				subject: 'Hello',
				audience: { kind: 'topic', topicId },
				status: 'sent',
			}));

			// Create email sends: 2 sent, 1 opened, 1 clicked
			await ctx.db.insert('emailSends', createTestEmailSend({
				campaignId,
				contactId,
				status: 'delivered',
				sentAt: now - 200000,
			}));
			await ctx.db.insert('emailSends', createTestEmailSend({
				campaignId: await ctx.db.insert('campaigns', createTestCampaign({
					name: 'Campaign 2',
					audience: { kind: 'topic', topicId },
					status: 'sent',
				})),
				contactId,
				status: 'opened',
				sentAt: now - 100000,
				openedAt: now - 50000,
				openCount: 2,
			}));
		});

		const details = await t.query(api.topics.topics.getContactInTopicDetails, {
			topicId: topicId!,
			contactId: contactId!,
		});

		expect(details).toBeDefined();
		expect(details!.topic.name).toBe('Analytics List');
		expect(details!.contact.email).toBe('analytics@example.com');
		expect(details!.contact.firstName).toBe('Ana');
		expect(details!.membership.addedAt).toBe(now);
		expect(details!.emailHistory).toHaveLength(2);
		expect(details!.emailStats.totalSent).toBe(2);
		expect(details!.emailStats.totalOpened).toBe(1);
	});

	it('should return null when no membership exists', async () => {
		const t = convexTest(schema, modules);
		let topicId: Id<'topics'>;
		let contactId: Id<'contacts'>;

		await t.run(async (ctx) => {
			topicId = await ctx.db.insert('topics', createTestTopic());
			contactId = await ctx.db.insert('contacts', createTestContact());
			// No membership created
		});

		const details = await t.query(api.topics.topics.getContactInTopicDetails, {
			topicId: topicId!,
			contactId: contactId!,
		});

		expect(details).toBeNull();
	});

	it('should calculate correct open/click rates', async () => {
		const t = convexTest(schema, modules);
		let topicId: Id<'topics'>;
		let contactId: Id<'contacts'>;
		const now = Date.now();

		await t.run(async (ctx) => {
			topicId = await ctx.db.insert('topics', createTestTopic());
			contactId = await ctx.db.insert('contacts', createTestContact());
			await ctx.db.insert('contactTopics', {
				contactId,
				topicId: topicId,
				addedAt: now,
			});

			// Create 4 campaigns targeting this topic with different engagement
			const makeCampaignAndSend = async (
				name: string,
				status: string,
				openedAt?: number,
				clickedAt?: number,
			) => {
				const campaignId = await ctx.db.insert('campaigns', createTestCampaign({
					name,
					audience: { kind: 'topic', topicId },
					status: 'sent',
				}));
				await ctx.db.insert('emailSends', createTestEmailSend({
					campaignId,
					contactId,
					status,
					sentAt: now - 300000,
					openedAt,
					clickedAt,
					openCount: openedAt ? 1 : 0,
					clickedLinks: clickedAt ? [{ url: 'https://example.com', clickedAt }] : undefined,
				}));
			};

			// 4 sends: 2 opened, 1 clicked
			await makeCampaignAndSend('C1', 'delivered');
			await makeCampaignAndSend('C2', 'opened', now - 200000);
			await makeCampaignAndSend('C3', 'clicked', now - 150000, now - 100000);
			await makeCampaignAndSend('C4', 'delivered');
		});

		const details = await t.query(api.topics.topics.getContactInTopicDetails, {
			topicId: topicId!,
			contactId: contactId!,
		});

		expect(details!.emailStats.totalSent).toBe(4);
		expect(details!.emailStats.totalOpened).toBe(2); // C2 (opened) + C3 (clicked also has openedAt)
		expect(details!.emailStats.totalClicked).toBe(1);
		expect(details!.emailStats.openRate).toBe(50); // 2/4 * 100
		expect(details!.emailStats.clickRate).toBe(25); // 1/4 * 100
		expect(details!.emailStats.lastEngagement).toBeGreaterThan(0);
	});
});
