/**
 * The Postbox feature floor, on the backend.
 *
 * `/dashboard/postbox` declares `requiresAnyFeature: ['postbox','mail.external']`
 * in the web app, but a route guard only decides what the browser renders —
 * Convex publishes every public function on the deployment's client API, so
 * until these gates existed any authenticated member could create folders,
 * drafts and labels on an instance where personal mail was switched off.
 *
 * Two layers are pinned here, because they behave differently on purpose:
 *
 *   - `postboxMutation` / `postboxQuery` (mail/_helpers.ts) THROW `forbidden`
 *     naming both flags. That is the right answer for a write: the caller asked
 *     for something the instance does not offer.
 *   - the mailbox gate (`requireMailboxAccess` / `loadAccessibleMailboxes`)
 *     reports `feature_off` instead, so the soft-failing `publicQuery` reads
 *     keep their "return the empty shape, never throw" contract. Those reads
 *     are subscribed from places with no feature meta (global search, the
 *     desktop unread peek), where a throw would be a visible error rather than
 *     an empty state.
 *
 * Either flag alone opens the surface: `mail.external` deliberately does not
 * depend on `postbox`, so requiring `postbox` would lock out every instance
 * that only connects existing mailboxes.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../../schema';
import { api } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { enableFeatures } from '../../__tests__/factories';
import { modules, seedFolder, seedMailbox, seedMessage } from './helpers.testlib';

// The feature floor runs after the auth floor, so the session has to pass for
// the flag decision to be the one under test.
vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	const session = { userId: 'user-A', role: 'owner', activeOrganizationId: 'org-1' };
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue(session),
		getMutationContext: vi.fn().mockResolvedValue(session),
		requireAdminContext: vi.fn().mockResolvedValue(session),
		requireOrgPermission: vi.fn().mockResolvedValue(session),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('user-A'),
		getBetterAuthSessionWithRole: vi.fn().mockResolvedValue(session),
	};
});

describe('postboxMutation refuses when the instance has no personal mail', () => {
	it('names both flags when neither is enabled', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, { featuresOff: true });

		await expect(
			t.mutation(api.mail.folders.create, { mailboxId, name: 'Receipts' })
		).rejects.toThrow(/"postbox".*"mail\.external"/);

		// The floor ran before the handler: nothing was written.
		await t.run(async (ctx) => {
			expect(await ctx.db.query('mailFolders').collect()).toHaveLength(0);
		});
	});

	it.each(['postbox', 'mail.external'] as const)('passes the floor with %s alone', async (flag) => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, [flag]);
		const mailboxId = await seedMailbox(t);

		await expect(
			t.mutation(api.mail.folders.create, { mailboxId, name: 'Receipts' })
		).resolves.toBeDefined();
	});

	it('refuses a draft write too — the gate is the builder, not one handler', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, { featuresOff: true });

		await expect(t.mutation(api.mail.drafts.create, { mailboxId })).rejects.toThrow(
			/"postbox".*"mail\.external"/
		);
	});
});

describe('the mailbox gate reports feature_off without throwing', () => {
	/**
	 * One mailbox holding one inbox message. The read under test is only a real
	 * probe of the gate when the mailbox HAS mail: an empty mailbox returns the
	 * same empty page gated or not.
	 */
	async function seedMailboxWithOneMessage(
		t: ReturnType<typeof convexTest<typeof schema>>,
		opts: { featuresOff?: boolean } = {}
	): Promise<Id<'mailboxes'>> {
		const mailboxId = await seedMailbox(t, { featuresOff: opts.featuresOff });
		await seedFolder(t, mailboxId, 'inbox');
		await seedMessage(t, mailboxId, { subject: 'quarterly review' });
		return mailboxId;
	}

	it('soft-fails a mailbox read to its empty shape when neither flag is on', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailboxWithOneMessage(t, { featuresOff: true });

		// The mailbox holds a message the caller owns; it stays invisible because
		// the instance has no personal-mail capability — and the read returns the
		// empty page rather than throwing, which is what keeps the always-mounted
		// subscribers (global search, the desktop unread peek) quiet.
		const page = await t.query(api.mail.mailbox.queries.listMessages, { mailboxId });
		expect(page.messages).toEqual([]);
		expect(page.hasMore).toBe(false);
	});

	it.each(['postbox', 'mail.external'] as const)(
		'returns the mailbox contents once %s is on',
		async (flag) => {
			const t = convexTest(schema, modules);
			const mailboxId = await seedMailboxWithOneMessage(t, { featuresOff: true });
			await enableFeatures(t, [flag]);

			const page = await t.query(api.mail.mailbox.queries.listMessages, { mailboxId });
			expect(page.messages).toHaveLength(1);
			expect(page.messages[0]!.subject).toBe('quarterly review');
		}
	);
});
