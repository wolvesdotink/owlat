import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../schema';
import { createTestContact } from './factories';
import { permanentlyDeleteContactWithRelations } from '../lib/contactMutations';
import type { Id } from '../_generated/dataModel';

const modules = import.meta.glob('../**/*.*s');

/**
 * Guards the permanent-delete cascade in lib/contactMutations.ts: after a hard
 * delete there must be NO live row anywhere whose `contactId` still points at the
 * removed contact. Owned rows are deleted; soft-deletable audit rows keep the FK
 * but gain `deletedAt`; optional-FK audit rows have the FK cleared to undefined.
 */
describe('permanentlyDeleteContactWithRelations', () => {
	it('leaves no dangling contactId FK across every referencing table', async () => {
		const t = convexTest(schema, modules);

		const ids = await t.run(async (ctx) => {
			const contactId = await ctx.db.insert('contacts', createTestContact({
				email: 'cascade-victim@example.com',
			}));

			// Owned children (required/owned FK) — expected DELETED.
			const topicId = await ctx.db.insert('topics', { name: 'T', createdAt: Date.now() });
			const membershipId = await ctx.db.insert('contactTopics', {
				contactId,
				topicId,
				addedAt: Date.now(),
			});
			const propertyId = await ctx.db.insert('contactProperties', {
				key: 'company',
				label: 'Company',
				type: 'string' as const,
				createdAt: Date.now(),
			});
			const propertyValueId = await ctx.db.insert('contactPropertyValues', {
				contactId,
				propertyId,
				value: 'Acme',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			const activityId = await ctx.db.insert('contactActivities', {
				contactId,
				activityType: 'email_opened' as const,
				occurredAt: Date.now(),
			});
			const identityId = await ctx.db.insert('contactIdentities', {
				contactId,
				channel: 'email',
				identifier: 'cascade-victim@example.com',
				isPrimary: true,
				createdAt: Date.now(),
			});
			const automationId = await ctx.db.insert('automations', {
				name: 'A',
				triggerType: 'contact_created' as const,
				status: 'active' as const,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			const automationRunId = await ctx.db.insert('automationRuns', {
				automationId,
				contactId,
				currentStepIndex: 0,
				status: 'running' as const,
				startedAt: Date.now(),
				triggeredBy: 'contact_created',
			});

			// Soft-deletable audit rows — expected to keep the FK but gain deletedAt.
			const campaignId = await ctx.db.insert('campaigns', {
				name: 'C',
				status: 'sent' as const,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			const emailSendId = await ctx.db.insert('emailSends', {
				campaignId,
				contactId,
				contactEmail: 'cascade-victim@example.com',
				status: 'sent' as const,
				queuedAt: Date.now(),
			});
			const transactionalEmailId = await ctx.db.insert('transactionalEmails', {
				name: 'TX',
				slug: 'tx',
				subject: 'Hi',
				content: '[]',
				status: 'published' as const,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			const transactionalSendId = await ctx.db.insert('transactionalSends', {
				kind: 'transactional' as const,
				transactionalEmailId,
				contactId,
				email: 'cascade-victim@example.com',
				status: 'sent' as const,
			});

			// Optional-FK audit rows without a soft-delete column — expected FK CLEARED.
			const threadId = await ctx.db.insert('conversationThreads', {
				subject: 'S',
				normalizedSubject: 's',
				contactId,
				contactIdentifier: 'cascade-victim@example.com',
				status: 'open' as const,
				messageCount: 1,
				lastMessageAt: Date.now(),
				firstMessageAt: Date.now(),
				createdAt: Date.now(),
			});
			const unifiedMessageId = await ctx.db.insert('unifiedMessages', {
				threadId,
				channel: 'email' as const,
				direction: 'inbound' as const,
				contactId,
				content: JSON.stringify({ text: 'hello' }),
				status: 'received' as const,
				createdAt: Date.now(),
			});
			const formEndpointId = await ctx.db.insert('formEndpoints', {
				name: 'F',
				fields: [],
				isActive: true,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			const formSubmissionId = await ctx.db.insert('formSubmissions', {
				formEndpointId,
				contactId,
				data: { email: 'cascade-victim@example.com' },
				status: 'success' as const,
				submittedAt: Date.now(),
			});
			const inboundMessageId = await ctx.db.insert('inboundMessages', {
				messageId: '<x@example.com>',
				from: 'cascade-victim@example.com',
				to: 'support@us.com',
				subject: 'Help',
				processingStatus: 'received' as const,
				contactId,
				threadId,
				receivedAt: Date.now(),
			});

			return {
				contactId,
				membershipId,
				propertyValueId,
				activityId,
				identityId,
				automationRunId,
				emailSendId,
				transactionalSendId,
				threadId,
				unifiedMessageId,
				formSubmissionId,
				inboundMessageId,
			};
		});

		await t.run(async (ctx) => {
			await permanentlyDeleteContactWithRelations(ctx, ids.contactId);
		});

		await t.run(async (ctx) => {
			// Contact gone.
			expect(await ctx.db.get(ids.contactId)).toBeNull();

			// Owned rows deleted.
			expect(await ctx.db.get(ids.membershipId)).toBeNull();
			expect(await ctx.db.get(ids.propertyValueId)).toBeNull();
			expect(await ctx.db.get(ids.activityId)).toBeNull();
			expect(await ctx.db.get(ids.identityId)).toBeNull();
			expect(await ctx.db.get(ids.automationRunId)).toBeNull();

			// Send rows: survive for stat integrity, but the denormalized
			// recipient identity is SCRUBBED (GDPR erasure) and deletedAt set.
			const emailSend = await ctx.db.get(ids.emailSendId);
			expect(emailSend).not.toBeNull();
			expect(emailSend?.contactId).toBe(ids.contactId);
			expect(emailSend?.deletedAt).toBeDefined();
			expect(emailSend?.contactEmail).toBe('[erased]');
			expect(emailSend?.contactFirstName).toBeUndefined();
			expect(emailSend?.contactLastName).toBeUndefined();
			const txSend = await ctx.db.get(ids.transactionalSendId);
			expect(txSend).not.toBeNull();
			expect(txSend?.contactId).toBe(ids.contactId);
			expect(txSend?.deletedAt).toBeDefined();
			expect(txSend?.email).toBe('[erased]');

			// Conversation content is the contact's personal data — DELETED,
			// not unlinked (the old clear-FK behavior retained message bodies
			// and addresses after "permanent" deletion).
			expect(await ctx.db.get(ids.threadId)).toBeNull();
			expect(await ctx.db.get(ids.unifiedMessageId)).toBeNull();
			expect(await ctx.db.get(ids.formSubmissionId)).toBeNull();
			expect(await ctx.db.get(ids.inboundMessageId)).toBeNull();
		});

		// Sweep every by_contact-indexed table to prove zero dangling FKs remain.
		await t.run(async (ctx) => {
			const tablesWithContactFk = [
				'contactTopics',
				'contactPropertyValues',
				'contactActivities',
				'contactIdentities',
				'automationRuns',
				'unifiedMessages',
				'formSubmissions',
				'inboundMessages',
				'conversationThreads',
			] as const;
			for (const table of tablesWithContactFk) {
				const dangling = await ctx.db
					.query(table)
					.withIndex('by_contact', (q) =>
						q.eq('contactId', ids.contactId as Id<'contacts'>),
					)
					.collect();
				expect(dangling, `dangling FK rows in ${table}`).toHaveLength(0);
			}
		});
	});
});

describe('permanentlyDeleteContactWithRelations — knowledge erasure', () => {
	it('tears down solely-scoped entries and unlinks shared ones', async () => {
		const t = convexTest(schema, modules);
		const ids = await t.run(async (ctx) => {
			const contactId = await ctx.db.insert('contacts', createTestContact({}));
			const otherId = await ctx.db.insert('contacts', createTestContact({ email: 'other@example.com' }));

			// Entry scoped SOLELY to the contact (must be deleted, with relations).
			const entryBase = {
				entryType: 'fact',
				title: 'fact',
				sourceType: 'manual',
				embedding: [0.1, 0.2],
				confidence: 0.9,
				lastValidatedAt: Date.now(),
				createdAt: Date.now(),
				updatedAt: Date.now(),
			};
			const soleEntryId = await ctx.db.insert('knowledgeEntries', {
				...entryBase,
				content: 'Prefers EUR invoices',
				contactIds: [contactId],
			} as never);
			await ctx.db.insert('knowledgeEntryContacts', { entryId: soleEntryId, contactId });

			// Entry shared with another contact (must only lose the link).
			const sharedEntryId = await ctx.db.insert('knowledgeEntries', {
				...entryBase,
				content: 'Works at ACME',
				contactIds: [contactId, otherId],
			} as never);
			await ctx.db.insert('knowledgeEntryContacts', { entryId: sharedEntryId, contactId });
			await ctx.db.insert('knowledgeEntryContacts', { entryId: sharedEntryId, contactId: otherId });

			const relationId = await ctx.db.insert('knowledgeRelations', {
				fromEntryId: soleEntryId,
				toEntryId: sharedEntryId,
				relationType: 'relates_to',
				confidenceTag: 'extracted',
				confidence: 1.0,
				provenance: 'manual',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			} as never);

			// Semantic file linked to the contact (org document — unlink only).
			const storageId = await ctx.storage.store(new Blob(['pdf-bytes']));
			const fileId = await ctx.db.insert('semanticFiles', {
				storageId,
				filename: 'contract.pdf',
				mimeType: 'application/pdf',
				fileSize: 9,
				sourceType: 'upload',
				version: 1,
				embedding: [0.1, 0.2],
				contactIds: [contactId, otherId],
				createdAt: Date.now(),
				updatedAt: Date.now(),
			} as never);
			await ctx.db.insert('semanticFileContacts', { fileId, contactId });
			await ctx.db.insert('semanticFileContacts', { fileId, contactId: otherId });

			return { contactId, otherId, soleEntryId, sharedEntryId, relationId, fileId };
		});

		await t.run(async (ctx) => {
			await permanentlyDeleteContactWithRelations(ctx, ids.contactId);
		});

		await t.run(async (ctx) => {
			// Solely-scoped entry torn down, including its relations.
			expect(await ctx.db.get(ids.soleEntryId)).toBeNull();
			expect(await ctx.db.get(ids.relationId)).toBeNull();

			// Shared entry survives but no longer references the erased contact.
			const shared = await ctx.db.get(ids.sharedEntryId);
			expect(shared).not.toBeNull();
			expect(shared?.contactIds).toEqual([ids.otherId]);

			// File survives, link removed, other contact's link intact.
			const file = await ctx.db.get(ids.fileId);
			expect(file).not.toBeNull();
			expect(file?.contactIds).toEqual([ids.otherId]);

			const junctions = await ctx.db
				.query('knowledgeEntryContacts')
				.withIndex('by_contact', (q) => q.eq('contactId', ids.contactId))
				.collect();
			expect(junctions).toHaveLength(0);
			const fileJunctions = await ctx.db
				.query('semanticFileContacts')
				.withIndex('by_contact', (q) => q.eq('contactId', ids.contactId))
				.collect();
			expect(fileJunctions).toHaveLength(0);
		});
	});
});
