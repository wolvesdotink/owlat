/**
 * The sender identity the recipient-facing pages lead with (#798). A person
 * unsubscribing from a newsletter has never heard of Owlat, so the page names
 * the sender, and when the link is broken it offers the sender's address as
 * the other way to opt out. Token-independent, so it answers without a session
 * and without a valid token — and it returns nothing beyond the From identity.
 */
import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import schema from '../../schema';
import { api } from '../../_generated/api';
import { modules } from '../../__tests__/testModules';

describe('delivery.unsubscribeQueries.getRecipientSender', () => {
	it('returns the default sender name and address, trimmed, without a session', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', {
				defaultFromName: ' Northwind Studio ',
				defaultFromEmail: 'hello@northwind.example',
				timezone: 'Europe/Berlin',
				createdAt: 1,
			});
		});

		const sender = await t.query(api.delivery.unsubscribeQueries.getRecipientSender, {});
		expect(sender).toEqual({ name: 'Northwind Studio', contactEmail: 'hello@northwind.example' });
	});

	it('answers nulls rather than a placeholder when nothing is configured', async () => {
		const t = convexTest(schema, modules);
		const sender = await t.query(api.delivery.unsubscribeQueries.getRecipientSender, {});
		expect(sender).toEqual({ name: null, contactEmail: null });
	});

	it('treats a blank name or address as unset', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', {
				defaultFromName: '  ',
				defaultFromEmail: '',
				createdAt: 1,
			});
		});
		const sender = await t.query(api.delivery.unsubscribeQueries.getRecipientSender, {});
		expect(sender).toEqual({ name: null, contactEmail: null });
	});
});
