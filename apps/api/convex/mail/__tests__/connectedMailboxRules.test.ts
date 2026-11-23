/**
 * Forwarding and the vacation reply run only for mail Owlat's own MTA receives.
 * A connected mailbox's mail is delivered by its provider and synced in later,
 * so a rule saved for it would read as active and never run. The save
 * mutations refuse it; turning a rule off or deleting it stays possible.
 */

import { convexTest } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { api } from '../../_generated/api';
import { modules, seedMailbox } from './helpers.testlib';

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	const session = async () => ({
		userId: 'user-A',
		role: 'editor' as const,
		activeOrganizationId: 'org-1',
	});
	return {
		...actual,
		requireOrgMember: vi.fn(session),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn(session),
		getBetterAuthSessionWithRole: vi.fn(session),
	};
});

const responder = {
	isEnabled: true,
	subject: 'Out of office',
	bodyText: 'Back on Monday.',
	replyIntervalDays: 7,
};

describe('rules Owlat cannot run for a connected mailbox', () => {
	it('refuses a forwarding rule and a vacation reply for a connected mailbox', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, { kind: 'external', address: 'me@gmail.test' });

		await expect(
			t.mutation(api.mail.forwarding.create, { mailboxId, forwardTo: 'desk@elsewhere.test' })
		).rejects.toThrow(/synced from its provider/);
		await expect(t.mutation(api.mail.vacation.upsert, { mailboxId, ...responder })).rejects.toThrow(
			/synced from its provider/
		);
		await t.run(async (ctx) => {
			expect(await ctx.db.query('mailForwarding').collect()).toEqual([]);
			expect(await ctx.db.query('mailVacationResponders').collect()).toEqual([]);
		});
	});

	it('refuses to switch on a rule stored for a connected mailbox, but turns it off and deletes it', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, { kind: 'external', address: 'me@gmail.test' });
		const ruleId = await t.run(async (ctx) => {
			await ctx.db.insert('mailVacationResponders', {
				mailboxId,
				...responder,
				createdAt: 1,
				updatedAt: 1,
			});
			return await ctx.db.insert('mailForwarding', {
				mailboxId,
				forwardTo: 'desk@elsewhere.test',
				keepLocalCopy: true,
				isEnabled: false,
				createdAt: 1,
				updatedAt: 1,
			});
		});

		await expect(
			t.mutation(api.mail.forwarding.update, { id: ruleId, isEnabled: true })
		).rejects.toThrow(/synced from its provider/);
		await t.mutation(api.mail.forwarding.update, { id: ruleId, isEnabled: false });
		await t.mutation(api.mail.forwarding.remove, { id: ruleId });
		await t.mutation(api.mail.vacation.remove, { mailboxId });
		await t.run(async (ctx) => {
			expect(await ctx.db.query('mailForwarding').collect()).toEqual([]);
			expect(await ctx.db.query('mailVacationResponders').collect()).toEqual([]);
		});
	});

	it('saves both for a hosted mailbox', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);

		await t.mutation(api.mail.forwarding.create, { mailboxId, forwardTo: 'desk@elsewhere.test' });
		await t.mutation(api.mail.vacation.upsert, { mailboxId, ...responder });
		await t.run(async (ctx) => {
			expect(await ctx.db.query('mailForwarding').collect()).toHaveLength(1);
			expect(await ctx.db.query('mailVacationResponders').collect()).toHaveLength(1);
		});
	});
});
