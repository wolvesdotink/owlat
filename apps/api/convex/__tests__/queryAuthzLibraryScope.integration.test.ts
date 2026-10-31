/**
 * What the audience, delivery and transactional reads return once their
 * authorization decision is applied, with real sessions: a soft-deleted
 * contact reads as missing through every id lookup (as in contacts.get), a
 * Team inbox reply send follows the shared-inbox reader rule, an erased
 * campaign send reads as absent, and the owner/admin forms and import reads
 * still serve their data to owners and admins.
 */

import { describe, it, expect } from 'vitest';
import { api } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import {
	createTestEmailSend,
	createTestFormSubmission,
	createTestTopic,
	createTestTransactionalEmail,
} from './factories';
import {
	ADMIN,
	EDITOR,
	OWNER,
	as,
	authzHarness,
	type Harness,
	type Seed,
} from './queryAuthzFixtures';

/** Soft-delete the seeded contact the way a user does. */
async function deleteContact(t: Harness, seed: Seed): Promise<void> {
	await as(t, seed, OWNER).mutation(api.contacts.contacts.remove, { contactId: seed.contactId });
}

describe('reads that resolve a contact by id', () => {
	it("contacts.propertyValues.listByContact hides a deleted contact's values", async () => {
		const { t, seed } = await authzHarness();
		await t.run(async (ctx) => {
			const now = Date.now();
			const propertyId = await ctx.db.insert('contactProperties', {
				key: 'phone',
				label: 'Phone',
				type: 'string',
				createdAt: now,
			});
			await ctx.db.insert('contactPropertyValues', {
				contactId: seed.contactId,
				propertyId,
				value: '+1 555 0100',
				createdAt: now,
				updatedAt: now,
			});
		});
		const editor = as(t, seed, EDITOR);
		const args = { contactId: seed.contactId };
		expect(
			(await editor.query(api.contacts.propertyValues.listByContact, args)).map((row) => row.value)
		).toEqual(['+1 555 0100']);

		await deleteContact(t, seed);

		expect(await editor.query(api.contacts.propertyValues.listByContact, args)).toEqual([]);
		// The values stay for the retention window; only the read hides them.
		const retained = await t.run((ctx) => ctx.db.query('contactPropertyValues').collect());
		expect(retained).toHaveLength(1);
	});

	it('topic reads treat a deleted member as missing', async () => {
		const { t, seed } = await authzHarness();
		const topicId = await t.run(async (ctx) => {
			const id = await ctx.db.insert('topics', createTestTopic({ name: 'Newsletter' }));
			await ctx.db.insert('contactTopics', {
				contactId: seed.contactId,
				topicId: id,
				addedAt: Date.now(),
			});
			return id;
		});
		const editor = as(t, seed, EDITOR);
		const details = { topicId, contactId: seed.contactId };
		expect(
			(
				await editor.query(api.topics.topics.getTopicsForContact, { contactId: seed.contactId })
			).map((topic) => topic.name)
		).toEqual(['Newsletter']);
		expect(
			(await editor.query(api.topics.topics.getContactInTopicDetails, details))?.contact.email
		).toBe('reader@example.com');

		await deleteContact(t, seed);

		expect(
			await editor.query(api.topics.topics.getTopicsForContact, { contactId: seed.contactId })
		).toEqual([]);
		expect(await editor.query(api.topics.topics.getContactInTopicDetails, details)).toBeNull();
		const memberships = await t.run((ctx) => ctx.db.query('contactTopics').collect());
		expect(memberships).toHaveLength(1);
	});

	it('transactional send reads join a deleted contact as null, keeping the send', async () => {
		const { t, seed } = await authzHarness();
		const { transactionalEmailId, sendId } = await t.run(async (ctx) => {
			const emailId = await ctx.db.insert('transactionalEmails', createTestTransactionalEmail());
			const id = await ctx.db.insert('transactionalSends', {
				kind: 'transactional',
				transactionalEmailId: emailId,
				email: 'reader@example.com',
				contactId: seed.contactId,
				status: 'sent',
			});
			return { transactionalEmailId: emailId, sendId: id };
		});
		const editor = as(t, seed, EDITOR);
		const read = async () => ({
			one: await editor.query(api.transactional.sends.get, { id: sendId }),
			list: await editor.query(api.transactional.sends.listByTransactionalEmail, {
				transactionalEmailId,
			}),
		});

		const before = await read();
		expect(before.one?.contact?.firstName).toBeDefined();
		expect(before.list.sends.map((send) => send.contact?._id)).toEqual([seed.contactId]);

		await deleteContact(t, seed);

		const after = await read();
		expect(after.one?._id).toBe(sendId);
		expect(after.one?.contact).toBeNull();
		expect(after.list.sends.map((send) => [send._id, send.contact])).toEqual([[sendId, null]]);
	});
});

describe('transactional.sends.get', () => {
	async function sendsOfEveryKind(t: Harness, seed: Seed) {
		return await t.run(async (ctx) => {
			const transactionalEmailId = await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail()
			);
			const insert = (fields: Record<string, unknown>) =>
				ctx.db.insert('transactionalSends', {
					email: 'customer@example.com',
					status: 'sent',
					...fields,
				} as never);
			return {
				transactional: await insert({ kind: 'transactional', transactionalEmailId }),
				automation: await insert({ kind: 'automation', automationId: seed.automationId }),
				test: await insert({ kind: 'test' }),
				agentReply: await insert({ kind: 'agent_reply', subject: 'Re: refund' }),
				teamReply: await insert({ kind: 'team_reply', subject: 'Re: invoice' }),
			};
		});
	}

	it('serves Team inbox replies to shared-inbox readers only', async () => {
		const { t, seed } = await authzHarness();
		const ids = await sendsOfEveryKind(t, seed);
		const get = (
			caller: typeof OWNER | typeof ADMIN | typeof EDITOR,
			id: Id<'transactionalSends'>
		) => as(t, seed, caller).query(api.transactional.sends.get, { id });

		for (const id of [ids.agentReply, ids.teamReply]) {
			expect((await get(OWNER, id))?._id).toBe(id);
			expect((await get(ADMIN, id))?._id).toBe(id);
			expect(await get(EDITOR, id)).toBeNull();
		}
		for (const id of [ids.transactional, ids.automation, ids.test]) {
			expect((await get(EDITOR, id))?._id).toBe(id);
		}
	});
});

describe('delivery.sends.get', () => {
	it('reads an erased campaign send as absent', async () => {
		const { t, seed } = await authzHarness();
		const { liveId, erasedId } = await t.run(async (ctx) => {
			const fields = { campaignId: seed.campaignId, contactId: seed.contactId };
			return {
				liveId: await ctx.db.insert('emailSends', createTestEmailSend(fields)),
				erasedId: await ctx.db.insert(
					'emailSends',
					createTestEmailSend({ ...fields, deletedAt: Date.now() })
				),
			};
		});
		const editor = as(t, seed, EDITOR);
		expect((await editor.query(api.delivery.sends.get, { id: liveId }))?._id).toBe(liveId);
		expect(await editor.query(api.delivery.sends.get, { id: erasedId })).toBeNull();
	});
});

describe('owner/admin reads', () => {
	it('forms.endpoints serves forms and submissions, without the DOI token', async () => {
		const { t, seed } = await authzHarness();
		const formEndpointId = await t.run(async (ctx) => {
			const now = Date.now();
			const id = await ctx.db.insert('formEndpoints', {
				name: 'Signup',
				fields: [{ key: 'email', label: 'Email', type: 'email', required: true }],
				isActive: true,
				createdAt: now,
				updatedAt: now,
			});
			await ctx.db.insert(
				'formSubmissions',
				createTestFormSubmission({
					formEndpointId: id,
					contactId: seed.contactId,
					confirmationToken: 'form-doi-token',
				})
			);
			return id;
		});
		for (const caller of [OWNER, ADMIN] as const) {
			const reader = as(t, seed, caller);
			expect((await reader.query(api.forms.endpoints.listByTeam, {})).map((f) => f.name)).toEqual([
				'Signup',
			]);
			const submissions = await reader.query(api.forms.endpoints.getSubmissions, {
				formEndpointId,
			});
			expect(submissions).toHaveLength(1);
			expect(submissions[0]).not.toHaveProperty('confirmationToken');
		}
	});

	it('integrationImports.walker.getImportProgress serves the latest run', async () => {
		const { t, seed } = await authzHarness();
		await t.run(async (ctx) => {
			await ctx.db.insert('integrationImports', {
				provider: 'mailchimp',
				status: 'failed',
				cursor: '0',
				imported: 1,
				updated: 0,
				skipped: 0,
				failed: 1,
				errors: ['list not found'],
				handleDuplicates: 'skip',
				startedAt: Date.now(),
			});
		});
		for (const caller of [OWNER, ADMIN] as const) {
			const progress = await as(t, seed, caller).query(
				api.integrationImports.walker.getImportProgress,
				{}
			);
			expect(progress?.errors).toEqual(['list not found']);
		}
	});
});
