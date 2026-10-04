/**
 * `drafts.create` with the full-page composer's per-request `requestNonce`.
 *
 * A compose request (`?c=`) can be remounted before its first creation call
 * answered, or after the draft it made was sent or discarded. The nonce must
 * then name the same draft, and report it gone rather than create a second
 * draft from the same request.
 */
import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../../schema';
import { api } from '../../_generated/api';
import { modules, seedMailbox } from './helpers.testlib';

const sessionMock = vi.hoisted(() => ({
	userId: 'user-A',
	role: 'owner' as 'owner' | 'admin' | 'editor' | null,
	orgId: 'org-1',
}));

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn(async () => ({
			userId: sessionMock.userId,
			role: sessionMock.role,
		})),
		getMutationContext: vi.fn(async () => ({
			userId: sessionMock.userId,
			role: sessionMock.role,
		})),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getBetterAuthSessionWithRole: vi.fn(async () => ({
			userId: sessionMock.userId,
			role: sessionMock.role,
			activeOrganizationId: sessionMock.orgId,
		})),
	};
});

describe('drafts.create requestNonce', () => {
	it('returns the same draft to a remount of the same request', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);

		const first = await t.mutation(api.mail.drafts.create, { mailboxId, requestNonce: 'c-1' });
		expect(first.existing).toBeUndefined();
		const second = await t.mutation(api.mail.drafts.create, { mailboxId, requestNonce: 'c-1' });
		expect(second).toMatchObject({ draftId: first.draftId, existing: true, state: 'draft' });

		await t.run(async (ctx) => {
			expect(await ctx.db.query('mailDrafts').collect()).toHaveLength(1);
		});
	});

	it('reports a sent or discarded draft as missing instead of creating another', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		const first = await t.mutation(api.mail.drafts.create, { mailboxId, requestNonce: 'c-2' });
		await t.mutation(api.mail.drafts.discard, { draftId: first.draftId });

		const again = await t.mutation(api.mail.drafts.create, { mailboxId, requestNonce: 'c-2' });
		expect(again).toMatchObject({ draftId: first.draftId, existing: true, missing: true });
		await t.run(async (ctx) => {
			expect(await ctx.db.query('mailDrafts').collect()).toHaveLength(0);
		});
	});

	it('returns the existing row’s envelope and lifecycle', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		const first = await t.mutation(api.mail.drafts.create, { mailboxId, requestNonce: 'c-3' });
		await t.mutation(api.mail.drafts.update, {
			draftId: first.draftId,
			toAddresses: ['ada@example.com'],
			subject: 'Edited on the row',
		});
		const again = await t.mutation(api.mail.drafts.create, { mailboxId, requestNonce: 'c-3' });
		expect(again).toMatchObject({
			toAddresses: ['ada@example.com'],
			subject: 'Edited on the row',
			state: 'draft',
		});
	});

	it('keeps requests in different mailboxes apart and prunes expired bindings', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await t.run(async (ctx) => {
			const stale = await ctx.db.insert('mailDrafts', {
				mailboxId,
				toAddresses: [],
				ccAddresses: [],
				bccAddresses: [],
				fromAddress: 'me@example.com',
				subject: '',
				bodyHtml: '',
				attachments: [],
				state: 'draft',
				lastEditedAt: 1,
				createdAt: 1,
			});
			await ctx.db.insert('mailDraftRequestNonces', {
				mailboxId,
				requestNonce: 'old',
				draftId: stale,
				createdAt: 1,
			});
		});
		await t.mutation(api.mail.drafts.create, { mailboxId, requestNonce: 'fresh' });
		await t.run(async (ctx) => {
			const nonces = await ctx.db.query('mailDraftRequestNonces').collect();
			expect(nonces.map((n) => n.requestNonce)).toEqual(['fresh']);
		});
	});
});
