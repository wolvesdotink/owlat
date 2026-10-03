/**
 * Automation sends with a contact through the Send lifecycle (issue #1184).
 *
 * An automation email step stores both `contactId` and `automationId` on its
 * `transactionalSends` row, and every contact activity the lifecycle writes for
 * it carries `automationId` in its metadata. The `contactActivities` table
 * validator did not list that field, so the insert threw and rolled back the
 * whole transition: the send stayed `queued`, and its hard bounces and
 * complaints never reached `blockedEmails`. These tests drive each edge through
 * the real mutations and read the rows back.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, describe, expect, it } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { createTestAutomation, createTestContact, flushScheduled } from './factories';

const modules = import.meta.glob('../**/*.*s');

afterEach(async () => {
	// The lifecycle schedules webhook fanout and reputation work; drain it before
	// convex-test replaces its global state.
	await flushScheduled();
});

type Seeded = {
	t: TestConvex<typeof schema>;
	sendId: Id<'transactionalSends'>;
	contactId: Id<'contacts'>;
	automationId: Id<'automations'>;
	email: string;
};

async function seedAutomationSend(
	email: string,
	row: { status: 'queued' | 'sent'; providerMessageId?: string } = { status: 'queued' }
): Promise<Seeded> {
	const t = convexTest(schema, modules);
	let sendId: Id<'transactionalSends'>;
	let contactId: Id<'contacts'>;
	let automationId: Id<'automations'>;
	await t.run(async (ctx) => {
		contactId = await ctx.db.insert('contacts', createTestContact({ email }));
		automationId = await ctx.db.insert('automations', createTestAutomation({ status: 'active' }));
		sendId = await ctx.db.insert('transactionalSends', {
			kind: 'automation' as const,
			automationId,
			contactId,
			email,
			subject: 'Welcome aboard',
			status: row.status,
			queuedAt: 1000,
			...(row.status === 'sent' ? { sentAt: 2000 } : {}),
			...(row.providerMessageId ? { providerMessageId: row.providerMessageId } : {}),
		});
	});
	return { t, sendId: sendId!, contactId: contactId!, automationId: automationId!, email };
}

async function activitiesOf(seeded: Seeded, literal: string) {
	return await seeded.t.run(async (ctx) => {
		const rows = await ctx.db
			.query('contactActivities')
			.withIndex('by_contact', (q) => q.eq('contactId', seeded.contactId))
			.collect();
		return rows.filter((row) => row.activityType === literal);
	});
}

async function blockedRowsFor(seeded: Seeded) {
	return await seeded.t.run(async (ctx) =>
		ctx.db
			.query('blockedEmails')
			.withIndex('by_email', (q) => q.eq('email', seeded.email))
			.collect()
	);
}

describe('automation send with a contact', () => {
	it('queued -> sent succeeds and writes email_sent with automationId', async () => {
		const seeded = await seedAutomationSend('auto-sent@example.com');

		const outcome = await seeded.t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'transactional', id: seeded.sendId },
			transition: { to: 'sent', at: 3000, providerMessageId: 'auto-msg-sent' },
		});
		expect(outcome).toMatchObject({ ok: true, applied: 'transitioned' });

		await seeded.t.run(async (ctx) => {
			expect(await ctx.db.get(seeded.sendId)).toMatchObject({
				status: 'sent',
				providerMessageId: 'auto-msg-sent',
			});
		});
		const sent = await activitiesOf(seeded, 'email_sent');
		expect(sent).toHaveLength(1);
		expect(sent[0]!.metadata).toMatchObject({
			emailType: 'automation',
			automationId: seeded.automationId,
			emailSubject: 'Welcome aboard',
		});
	});

	it('MTA remote acceptance records sent and delivered for a bound automation send', async () => {
		const seeded = await seedAutomationSend('auto-mta@example.com');
		expect(
			await seeded.t.mutation(internal.delivery.sendLifecycle.bindMtaProviderIdentity, {
				send: { kind: 'transactional', id: seeded.sendId },
				providerMessageId: 'auto-msg-mta',
			})
		).toEqual({ ok: true });

		const outcome = await seeded.t.mutation(
			internal.delivery.sendLifecycle.recordMtaRemoteAcceptance,
			{ providerMessageId: 'auto-msg-mta', at: 3000 }
		);
		expect(outcome).toMatchObject({ ok: true });

		await seeded.t.run(async (ctx) => {
			expect(await ctx.db.get(seeded.sendId)).toMatchObject({ status: 'delivered' });
		});
		const sent = await activitiesOf(seeded, 'email_sent');
		expect(sent).toHaveLength(1);
		expect(sent[0]!.metadata).toMatchObject({ automationId: seeded.automationId });
	});

	it('a hard bounce succeeds, writes email_bounced with automationId and blocks the address', async () => {
		const seeded = await seedAutomationSend('auto-bounce@example.com', {
			status: 'sent',
			providerMessageId: 'auto-msg-bounce',
		});

		const outcome = await seeded.t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'transactional', id: seeded.sendId },
			transition: {
				to: 'bounced',
				at: 4000,
				bounceType: 'hard',
				bounceMessage: '550 no such user',
			},
		});
		expect(outcome).toMatchObject({ ok: true, applied: 'transitioned' });

		await seeded.t.run(async (ctx) => {
			expect(await ctx.db.get(seeded.sendId)).toMatchObject({
				status: 'bounced',
				bounceType: 'hard',
			});
		});
		const bounced = await activitiesOf(seeded, 'email_bounced');
		expect(bounced).toHaveLength(1);
		expect(bounced[0]!.metadata).toMatchObject({
			automationId: seeded.automationId,
			bounceType: 'hard',
			errorMessage: '550 no such user',
		});
		const blocked = await blockedRowsFor(seeded);
		expect(blocked).toHaveLength(1);
		expect(blocked[0]).toMatchObject({ reason: 'bounced', bounceType: 'hard' });
	});

	it('a complaint succeeds, writes email_complained with automationId and blocks the address', async () => {
		const seeded = await seedAutomationSend('auto-complaint@example.com', {
			status: 'sent',
			providerMessageId: 'auto-msg-complaint',
		});

		const outcome = await seeded.t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'transactional', id: seeded.sendId },
			transition: { to: 'complained', at: 5000 },
		});
		expect(outcome).toMatchObject({ ok: true, applied: 'transitioned' });

		await seeded.t.run(async (ctx) => {
			expect(await ctx.db.get(seeded.sendId)).toMatchObject({ status: 'complained' });
		});
		const complained = await activitiesOf(seeded, 'email_complained');
		expect(complained).toHaveLength(1);
		expect(complained[0]!.metadata).toMatchObject({ automationId: seeded.automationId });
		const blocked = await blockedRowsFor(seeded);
		expect(blocked).toHaveLength(1);
		expect(blocked[0]).toMatchObject({ reason: 'complained' });
	});
});
