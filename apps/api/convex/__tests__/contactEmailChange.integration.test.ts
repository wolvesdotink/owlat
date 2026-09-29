/**
 * Contact edit and strict create through the shared `contacts/contactEdit.ts`
 * helpers: an email edit re-keys the contact's identity row (so resolution
 * follows the new address and the old one is free again), and the session
 * mutations and their API-key twins share the same guards and audit rows.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ConvexError } from 'convex/values';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { resolveContact } from '../contacts/resolution';
import {
	createTestAutomation,
	createTestAutomationStep,
	createTestContact,
	flushScheduled,
} from './factories';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		requireOrgPermission: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
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
		decrementContactCount: vi.fn().mockResolvedValue(undefined),
		getCachedContactCount: vi.fn().mockResolvedValue(0),
		reconcileContactCount: vi.fn().mockResolvedValue(undefined),
	};
});

// Keep the automation step executor out so a fired trigger only records a run.
const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(([path]) => !path.includes('automationStepExecutor'))
);

afterEach(async () => {
	await flushScheduled();
});

const setup = () => convexTest(schema, modules);
type T = ReturnType<typeof setup>;

async function operationCategory(promise: Promise<unknown>): Promise<string> {
	const error = await promise.then(
		() => null,
		(e: unknown) => e
	);
	expect(error).toBeInstanceOf(ConvexError);
	return (error as ConvexError<{ category: string }>).data.category;
}

/** A contact created the real way, so it has its primary email identity row. */
async function createViaSession(t: T, email: string): Promise<Id<'contacts'>> {
	return await t.mutation(api.contacts.contacts.create, { email });
}

async function emailIdentities(t: T, contactId: Id<'contacts'>) {
	return await t.run(async (ctx) =>
		(
			await ctx.db
				.query('contactIdentities')
				.withIndex('by_contact', (q) => q.eq('contactId', contactId))
				.collect()
		).filter((row) => row.channel === 'email')
	);
}

async function auditRows(t: T, action: string, resourceId: string) {
	return await t.run(async (ctx) =>
		(await ctx.db.query('auditLogs').collect()).filter(
			(row) => row.action === action && row.resourceId === resourceId
		)
	);
}

async function expectReKeyed(t: T, contactId: Id<'contacts'>) {
	const upsert = await t.run((ctx) =>
		resolveContact(ctx, {
			channel: 'email',
			identifier: 'b@x.example',
			source: 'api',
			mode: 'upsert',
		})
	);
	expect(upsert).toEqual({ contactId, action: 'matched' });

	// The old address is free again: a strict create of it makes a new contact.
	const reclaimed = await createViaSession(t, 'a@x.example');
	expect(reclaimed).not.toBe(contactId);

	const rows = await emailIdentities(t, contactId);
	expect(rows.map((row) => [row.identifier, row.isPrimary])).toEqual([['b@x.example', true]]);
	const contact = await t.run((ctx) => ctx.db.get(contactId));
	expect(contact?.email).toBe('b@x.example');
	expect(contact?.searchableText).toContain('b@x.example');
}

describe('contact email change re-keys the identity row', () => {
	it('through the dashboard update', async () => {
		const t = setup();
		const contactId = await createViaSession(t, 'a@x.example');

		await t.mutation(api.contacts.contacts.update, { contactId, email: 'B@x.example ' });

		await expectReKeyed(t, contactId);
	});

	it('through the API-key updateForTeam', async () => {
		const t = setup();
		const contactId = await createViaSession(t, 'a@x.example');

		await t.mutation(internal.contacts.contacts.updateForTeam, {
			contactId,
			email: 'b@x.example',
		});

		await expectReKeyed(t, contactId);
	});

	it('refuses an address another contact holds only as a secondary identity', async () => {
		const t = setup();
		const holderId = await createViaSession(t, 'holder@x.example');
		await t.run(async (ctx) => {
			await ctx.db.insert('contactIdentities', {
				contactId: holderId,
				channel: 'email',
				identifier: 'merged@x.example',
				isPrimary: false,
				createdAt: Date.now(),
			});
		});
		const contactId = await createViaSession(t, 'a@x.example');

		const category = await operationCategory(
			t.mutation(api.contacts.contacts.update, { contactId, email: 'merged@x.example' })
		);

		expect(category).toBe('already_exists');
		const contact = await t.run((ctx) => ctx.db.get(contactId));
		expect(contact?.email).toBe('a@x.example');
	});

	it("promotes the contact's own secondary address to primary", async () => {
		const t = setup();
		const contactId = await createViaSession(t, 'a@x.example');
		await t.run(async (ctx) => {
			await ctx.db.insert('contactIdentities', {
				contactId,
				channel: 'email',
				identifier: 'b@x.example',
				isPrimary: false,
				createdAt: Date.now(),
			});
		});

		await t.mutation(api.contacts.contacts.update, { contactId, email: 'b@x.example' });

		const rows = await emailIdentities(t, contactId);
		expect(rows.map((row) => [row.identifier, row.isPrimary])).toEqual([['b@x.example', true]]);
		const contact = await t.run((ctx) => ctx.db.get(contactId));
		expect(contact?.email).toBe('b@x.example');
	});

	it('still refuses a legacy contact that has no identity row', async () => {
		const t = setup();
		await t.run((ctx) =>
			ctx.db.insert('contacts', createTestContact({ email: 'legacy@x.example' }))
		);
		const contactId = await createViaSession(t, 'a@x.example');

		const category = await operationCategory(
			t.mutation(api.contacts.contacts.update, { contactId, email: 'legacy@x.example' })
		);

		expect(category).toBe('already_exists');
	});

	it('inserts a primary identity for a legacy contact that had none', async () => {
		const t = setup();
		const contactId = await t.run((ctx) =>
			ctx.db.insert('contacts', createTestContact({ email: 'a@x.example' }))
		);

		await t.mutation(api.contacts.contacts.update, { contactId, email: 'b@x.example' });

		const rows = await emailIdentities(t, contactId);
		expect(rows.map((row) => [row.identifier, row.isPrimary])).toEqual([['b@x.example', true]]);
	});
});

describe('shared edit and create guards', () => {
	it('update refuses a soft-deleted contact and fires no trigger', async () => {
		const t = setup();
		const automationId = await t.run(async (ctx) => {
			const id = await ctx.db.insert(
				'automations',
				createTestAutomation({
					status: 'active',
					triggerType: 'contact_updated',
					triggerConfig: { propertyKey: 'firstName' },
				})
			);
			await ctx.db.insert(
				'automationSteps',
				createTestAutomationStep({ automationId: id, stepIndex: 0 })
			);
			return id;
		});
		const contactId = await t.run((ctx) =>
			ctx.db.insert(
				'contacts',
				createTestContact({ email: 'gone@x.example', firstName: 'Old', deletedAt: Date.now() })
			)
		);

		const category = await operationCategory(
			t.mutation(api.contacts.contacts.update, { contactId, firstName: 'New' })
		);
		await t.finishInProgressScheduledFunctions();

		expect(category).toBe('not_found');
		const contact = await t.run((ctx) => ctx.db.get(contactId));
		expect(contact?.firstName).toBe('Old');
		const runs = await t.run(async (ctx) =>
			(await ctx.db.query('automationRuns').collect()).filter(
				(run) => run.automationId === automationId
			)
		);
		expect(runs).toHaveLength(0);
		expect(await auditRows(t, 'contact.updated', contactId)).toHaveLength(0);
	});

	it('updateForTeam writes a contact.updated audit row as the api actor', async () => {
		const t = setup();
		const contactId = await createViaSession(t, 'a@x.example');

		await t.mutation(internal.contacts.contacts.updateForTeam, {
			contactId,
			firstName: 'Ada',
			lastName: 'Lovelace',
		});

		const rows = await auditRows(t, 'contact.updated', contactId);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.userId).toBe('api');
		expect(rows[0]?.details).toEqual({ changedProperties: 'firstName, lastName' });
	});

	it('updateForTeam rejects an overlong firstName', async () => {
		const t = setup();
		const contactId = await createViaSession(t, 'a@x.example');

		const category = await operationCategory(
			t.mutation(internal.contacts.contacts.updateForTeam, {
				contactId,
				firstName: 'x'.repeat(201),
			})
		);

		expect(category).toBe('invalid_input');
	});

	it('createForTeam writes a contact.created audit row as the api actor', async () => {
		const t = setup();

		const contactId = await t.mutation(internal.contacts.contacts.createForTeam, {
			email: 'API@x.example',
		});

		const rows = await auditRows(t, 'contact.created', contactId);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.userId).toBe('api');
		expect(rows[0]?.details).toEqual({ email: 'api@x.example' });
	});
});
