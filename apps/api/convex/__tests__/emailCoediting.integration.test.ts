/**
 * Email co-editing (emailCoediting/*, docs/adr/0071-email-coediting.md):
 *   - `open` seeds a session from the email and follows a row that changed
 *     elsewhere only while the session has nothing unsaved
 *   - edits to different blocks merge; the later write to one block wins and
 *     the tab whose change it replaced gets a notice (plus a version-history
 *     snapshot for templates)
 *   - a save with `coeditVersion` writes the session, never a stale payload
 *   - presence and edit leases; the sweep and the delete cascade
 *   - only members who may edit emails can write
 */

import { convexTest, type TestConvex } from 'convex-test';
import { ConvexError, type Value } from 'convex/values';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { COEDIT_LEASE_TTL_MS, COEDIT_PRESENCE_WINDOW_MS } from '../emailCoediting/target';
import { COEDIT_SESSION_IDLE_MS } from '../emailCoediting/sweep';
import { createTestEmailTemplate, createTestTransactionalEmail } from './factories';

const sessionMock = vi.hoisted(() => ({
	user: { id: 'user-a', role: 'owner' as 'owner' | 'admin' | 'editor' },
}));

const as = (id: string, role: 'owner' | 'admin' | 'editor' = 'owner') => {
	sessionMock.user.id = id;
	sessionMock.user.role = role;
};

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<Record<string, unknown>>('../lib/sessionOrganization');
	const current = async () => ({ userId: sessionMock.user.id, role: sessionMock.user.role });
	return {
		...actual,
		requireOrgMember: vi.fn().mockImplementation(current),
		getMutationContext: vi.fn().mockImplementation(current),
		requireOrgPermission: vi.fn().mockImplementation(current),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
	};
});

const modules = import.meta.glob('../**/*.*s');

const block = (id: string, html: string) => ({ id, type: 'text', content: { html } });
const CONTENT = JSON.stringify([block('a', 'Alpha'), block('b', 'Beta')]);

const seedTemplate = (t: TestConvex<typeof schema>, overrides: Record<string, unknown> = {}) =>
	t.run((ctx) =>
		ctx.db.insert(
			'emailTemplates',
			createTestEmailTemplate({
				status: 'draft',
				content: CONTENT,
				name: 'Welcome',
				subject: 'Hello',
				contentRevision: 3,
				...overrides,
			})
		)
	);

const templateTarget = (id: Id<'emailTemplates'>) => ({ type: 'emailTemplate' as const, id });

const update = (b: ReturnType<typeof block>, baseVersion: number) => ({
	kind: 'update' as const,
	block: JSON.stringify(b),
	afterId: null,
	baseVersion,
});

async function openTemplate(t: TestConvex<typeof schema>, overrides: Record<string, unknown> = {}) {
	const templateId = await seedTemplate(t, overrides);
	const target = templateTarget(templateId);
	await t.mutation(api.emailCoediting.sessions.open, { target });
	return { templateId, target };
}

async function operationError(promise: Promise<unknown>) {
	const error = await promise.then(
		() => null,
		(e: unknown) => e
	);
	expect(error).toBeInstanceOf(ConvexError);
	return (error as ConvexError<{ category: string; data?: Record<string, Value> }>).data;
}

const blocksOf = (session: { content: string } | null) =>
	(JSON.parse(session?.content ?? '[]') as ReturnType<typeof block>[]).map((b) => [
		b.id,
		b.content.html,
	]);

describe('sessions.open', () => {
	it('seeds the session from the email row', async () => {
		as('user-a');
		const t = convexTest(schema, modules);
		const { target } = await openTemplate(t);

		const session = await t.query(api.emailCoediting.sessions.get, { target });
		expect(session).toMatchObject({ version: 1, savedVersion: 1, baseRevision: 3 });
		expect(blocksOf(session)).toEqual([
			['a', 'Alpha'],
			['b', 'Beta'],
		]);
		expect(JSON.parse(session!.fields)).toEqual({
			name: 'Welcome',
			subject: 'Hello',
			plainTextOverride: '',
		});
	});

	it('is idempotent and follows a changed row only while nothing is unsaved', async () => {
		as('user-a');
		const t = convexTest(schema, modules);
		const { templateId, target } = await openTemplate(t);
		await t.mutation(api.emailCoediting.sessions.open, { target });
		expect((await t.query(api.emailCoediting.sessions.get, { target }))?.version).toBe(1);

		// The translations page (or an API write) moves the row on.
		await t.run((ctx) => ctx.db.patch(templateId, { subject: 'Elsewhere', contentRevision: 4 }));
		await t.mutation(api.emailCoediting.sessions.open, { target });
		const followed = await t.query(api.emailCoediting.sessions.get, { target });
		expect(followed).toMatchObject({ version: 2, savedVersion: 2, baseRevision: 4 });
		expect(JSON.parse(followed!.fields).subject).toBe('Elsewhere');

		// With unsaved shared edits, the session is left alone.
		await t.mutation(api.emailCoediting.sessions.applyOps, {
			target,
			clientId: 'tab-1',
			ops: [update(block('a', 'Draft'), 2)],
		});
		await t.run((ctx) => ctx.db.patch(templateId, { contentRevision: 5 }));
		await t.mutation(api.emailCoediting.sessions.open, { target });
		const kept = await t.query(api.emailCoediting.sessions.get, { target });
		expect(kept).toMatchObject({ version: 3, savedVersion: 2, baseRevision: 4 });
	});

	it('refuses members who may not edit emails', async () => {
		as('user-a', 'editor');
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t);
		const data = await operationError(
			t.mutation(api.emailCoediting.sessions.open, { target: templateTarget(templateId) })
		);
		expect(data.category).toBe('forbidden');
	});
});

describe('sessions.applyOps', () => {
	it('merges edits to different blocks and sanitizes block HTML', async () => {
		as('user-a');
		const t = convexTest(schema, modules);
		const { target } = await openTemplate(t);

		await t.mutation(api.emailCoediting.sessions.applyOps, {
			target,
			clientId: 'tab-1',
			ops: [update(block('a', 'Alpha 1<script>x()</script>'), 1)],
		});
		as('user-b');
		const result = await t.mutation(api.emailCoediting.sessions.applyOps, {
			target,
			clientId: 'tab-2',
			ops: [
				update(block('b', 'Beta 2'), 1),
				{
					kind: 'insert',
					block: JSON.stringify(block('c', 'Gamma')),
					afterId: 'b',
					baseVersion: 1,
				},
			],
		});

		expect(result).toEqual({ version: 3 });
		const session = await t.query(api.emailCoediting.sessions.get, { target });
		expect(blocksOf(session)).toEqual([
			['a', 'Alpha 1'],
			['b', 'Beta 2'],
			['c', 'Gamma'],
		]);
		expect(session?.savedVersion).toBe(1);
		expect(await t.run((ctx) => ctx.db.query('emailCoeditNotices').collect())).toEqual([]);
	});

	it('lets the later write to one block win, notifies the replaced tab and keeps a version', async () => {
		as('user-a');
		const t = convexTest(schema, modules);
		const { templateId, target } = await openTemplate(t);
		await t.mutation(api.emailCoediting.presence.heartbeat, { target, clientId: 'tab-1' });
		await t.mutation(api.emailCoediting.sessions.applyOps, {
			target,
			clientId: 'tab-1',
			ops: [update(block('a', 'Mine'), 1)],
		});

		as('user-b');
		await t.mutation(api.emailCoediting.sessions.applyOps, {
			target,
			clientId: 'tab-2',
			ops: [update(block('a', 'Theirs'), 1)],
		});

		expect(blocksOf(await t.query(api.emailCoediting.sessions.get, { target }))[0]).toEqual([
			'a',
			'Theirs',
		]);
		as('user-a');
		const notices = await t.query(api.emailCoediting.notices.listForClient, {
			clientId: 'tab-1',
		});
		expect(notices).toHaveLength(1);
		expect(notices[0]).toMatchObject({ key: 'block:a', replacedBy: 'user-b' });
		expect(JSON.parse(notices[0]!.replacedValue)).toEqual(block('a', 'Mine'));

		const versions = await t.query(api.emailTemplates.versions.list, { templateId });
		expect(versions[0]).toMatchObject({ trigger: 'conflict', createdBy: 'user-a' });
		const snapshot = await t.query(api.emailTemplates.versions.get, {
			versionId: versions[0]!._id,
		});
		expect(JSON.parse(snapshot.content)[0].content.html).toBe('Mine');

		await t.mutation(api.emailCoediting.notices.dismiss, {
			noticeId: notices[0]!.noticeId,
			clientId: 'tab-1',
		});
		expect(await t.query(api.emailCoediting.notices.listForClient, { clientId: 'tab-1' })).toEqual(
			[]
		);
	});

	it('refuses an edit once the session is gone', async () => {
		as('user-a');
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t);
		const data = await operationError(
			t.mutation(api.emailCoediting.sessions.applyOps, {
				target: templateTarget(templateId),
				clientId: 'tab-1',
				ops: [update(block('a', 'x'), 1)],
			})
		);
		expect(data).toMatchObject({ category: 'conflict', data: { reason: 'coedit_session_gone' } });
	});

	it('refuses a field the template does not share', async () => {
		as('user-a');
		const t = convexTest(schema, modules);
		const { target } = await openTemplate(t);
		const data = await operationError(
			t.mutation(api.emailCoediting.sessions.applyOps, {
				target,
				clientId: 'tab-1',
				ops: [{ kind: 'field', field: 'attachments', value: '[]', baseVersion: 1 }],
			})
		);
		expect(data.category).toBe('invalid_input');
	});
});

describe('saving a co-edited email', () => {
	it('writes the session, not the stale payload of the saving tab', async () => {
		as('user-a');
		const t = convexTest(schema, modules);
		const { templateId, target } = await openTemplate(t);
		await t.mutation(api.emailCoediting.sessions.applyOps, {
			target,
			clientId: 'tab-1',
			ops: [
				update(block('a', 'Shared A'), 1),
				{
					kind: 'field',
					field: 'subject',
					value: JSON.stringify('Shared subject'),
					baseVersion: 1,
				},
			],
		});

		// A tab that never saw that edit saves its old copy of the blocks.
		as('user-b');
		const result = await t.mutation(api.emailTemplates.emails.update, {
			templateId,
			content: CONTENT,
			subject: 'Stale subject',
			expectedContentRevision: 3,
			coeditVersion: 1,
		});

		const row = await t.run((ctx) => ctx.db.get(templateId));
		expect(JSON.parse(row!.content)[0].content.html).toBe('Shared A');
		expect(row?.subject).toBe('Shared subject');
		expect(row?.htmlContent).toContain('Shared A');
		const session = await t.query(api.emailCoediting.sessions.get, { target });
		expect(session).toMatchObject({
			version: 2,
			savedVersion: 2,
			baseRevision: result.contentRevision,
		});
	});

	it('still refuses a save over a row that moved on outside the session', async () => {
		as('user-a');
		const t = convexTest(schema, modules);
		const { templateId } = await openTemplate(t);
		await t.run((ctx) => ctx.db.patch(templateId, { contentRevision: 9 }));
		const data = await operationError(
			t.mutation(api.emailTemplates.emails.update, {
				templateId,
				subject: 'x',
				expectedContentRevision: 3,
				coeditVersion: 1,
			})
		);
		expect(data.data).toMatchObject({ reason: 'stale_content_revision' });
	});

	it('saves the shared transactional fields', async () => {
		as('user-a');
		const t = convexTest(schema, modules);
		const emailId = await t.run((ctx) =>
			ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({ status: 'draft', content: CONTENT, contentRevision: 1 })
			)
		);
		const target = { type: 'transactionalEmail' as const, id: emailId };
		await t.mutation(api.emailCoediting.sessions.open, { target });
		await t.mutation(api.emailCoediting.sessions.applyOps, {
			target,
			clientId: 'tab-1',
			ops: [
				{ kind: 'field', field: 'showUnsubscribe', value: 'true', baseVersion: 1 },
				{
					kind: 'field',
					field: 'attachments',
					value: JSON.stringify([{ filename: 'a.pdf' }]),
					baseVersion: 1,
				},
			],
		});
		await t.mutation(api.transactional.emails.update, {
			id: emailId,
			expectedContentRevision: 1,
			coeditVersion: 2,
		});
		const row = await t.run((ctx) => ctx.db.get(emailId));
		expect(row?.showUnsubscribe).toBe(true);
		expect(JSON.parse(row!.attachments!)).toEqual([{ filename: 'a.pdf' }]);
	});
});

describe('sessions.reset', () => {
	it('throws the shared unsaved changes away', async () => {
		as('user-a');
		const t = convexTest(schema, modules);
		const { target } = await openTemplate(t);
		await t.mutation(api.emailCoediting.sessions.applyOps, {
			target,
			clientId: 'tab-1',
			ops: [update(block('a', 'Draft'), 1)],
		});
		await t.mutation(api.emailCoediting.sessions.reset, { target });
		const session = await t.query(api.emailCoediting.sessions.get, { target });
		expect(session).toMatchObject({ version: 3, savedVersion: 3 });
		expect(blocksOf(session)[0]).toEqual(['a', 'Alpha']);
	});
});

describe('presence and leases', () => {
	it('grants a lease to one tab and reports the holder to another', async () => {
		as('user-a');
		const t = convexTest(schema, modules);
		const { target } = await openTemplate(t);
		const first = await t.mutation(api.emailCoediting.presence.heartbeat, {
			target,
			clientId: 'tab-1',
			selectedBlockId: 'a',
			leaseBlockId: 'a',
		});
		expect(first).toEqual({ isLeaseHeld: true, heldBy: null });

		as('user-b');
		const second = await t.mutation(api.emailCoediting.presence.heartbeat, {
			target,
			clientId: 'tab-2',
			selectedBlockId: 'b',
			leaseBlockId: 'a',
		});
		expect(second).toEqual({ isLeaseHeld: false, heldBy: 'user-a' });

		const listed = await t.query(api.emailCoediting.presence.list, { target });
		expect(listed.people).toHaveLength(2);
		expect(listed.people.find((p) => p.clientId === 'tab-1')).toMatchObject({
			userId: 'user-a',
			selectedBlockId: 'a',
			leaseBlockId: 'a',
		});
		expect(listed.people.find((p) => p.clientId === 'tab-2')?.leaseBlockId).toBeNull();
	});

	it('frees a lease once it runs out, or when the holder leaves', async () => {
		as('user-a');
		const t = convexTest(schema, modules);
		const { target } = await openTemplate(t);
		await t.mutation(api.emailCoediting.presence.heartbeat, {
			target,
			clientId: 'tab-1',
			leaseBlockId: 'a',
		});
		await t.run(async (ctx) => {
			const row = await ctx.db
				.query('emailEditorPresence')
				.withIndex('by_client', (q) => q.eq('clientId', 'tab-1'))
				.first();
			await ctx.db.patch(row!._id, { leaseExpiresAt: Date.now() - 1 });
		});
		as('user-b');
		const taken = await t.mutation(api.emailCoediting.presence.heartbeat, {
			target,
			clientId: 'tab-2',
			leaseBlockId: 'a',
		});
		expect(taken.isLeaseHeld).toBe(true);

		await t.mutation(api.emailCoediting.presence.leave, { clientId: 'tab-2' });
		as('user-a');
		const back = await t.mutation(api.emailCoediting.presence.heartbeat, {
			target,
			clientId: 'tab-1',
			leaseBlockId: 'a',
		});
		expect(back.isLeaseHeld).toBe(true);
	});

	it("gives no lease to a member who may not edit, and refuses another user's tab id", async () => {
		as('user-a', 'editor');
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t);
		const target = templateTarget(templateId);
		const result = await t.mutation(api.emailCoediting.presence.heartbeat, {
			target,
			clientId: 'tab-1',
			leaseBlockId: 'a',
		});
		expect(result.isLeaseHeld).toBe(false);

		as('user-b');
		const data = await operationError(
			t.mutation(api.emailCoediting.presence.heartbeat, { target, clientId: 'tab-1' })
		);
		expect(data.category).toBe('forbidden');
	});

	it('uses a lease lifetime shorter than the presence window', () => {
		expect(COEDIT_LEASE_TTL_MS).toBeLessThan(COEDIT_PRESENCE_WINDOW_MS);
	});
});

describe('cleanup', () => {
	it('sweeps expired presence, old notices and idle sessions nobody has open', async () => {
		as('user-a');
		const t = convexTest(schema, modules);
		const { target } = await openTemplate(t);
		const busy = await openTemplate(t, { name: 'Busy' });
		const longAgo = Date.now() - COEDIT_SESSION_IDLE_MS - 1000;
		await t.mutation(api.emailCoediting.presence.heartbeat, {
			target: busy.target,
			clientId: 'tab-busy',
		});
		await t.run(async (ctx) => {
			for (const session of await ctx.db.query('emailCoeditSessions').collect()) {
				await ctx.db.patch(session._id, { lastActivityAt: longAgo });
			}
			await ctx.db.insert('emailEditorPresence', {
				targetType: 'emailTemplate',
				emailTemplateId: target.id,
				userId: 'user-gone',
				clientId: 'tab-gone',
				heartbeatAt: longAgo,
			});
			await ctx.db.insert('emailCoeditNotices', {
				targetType: 'emailTemplate',
				emailTemplateId: target.id,
				clientId: 'tab-gone',
				replacedBy: 'user-b',
				key: 'block:a',
				replacedValue: '{}',
				replacedValueVersion: 1,
				createdAt: longAgo,
			});
		});

		const swept = await t.mutation(internal.emailCoediting.sweep.internalSweep, {});
		expect(swept).toEqual({ presence: 1, notices: 1, sessions: 1 });
		expect(await t.query(api.emailCoediting.sessions.get, { target })).toBeNull();
		// Someone still has the busy email open: its draft stays.
		expect(await t.query(api.emailCoediting.sessions.get, { target: busy.target })).not.toBeNull();
	});

	it("deletes an email's co-editing rows with the email", async () => {
		as('user-a');
		const t = convexTest(schema, modules);
		const { templateId, target } = await openTemplate(t);
		await t.mutation(api.emailCoediting.presence.heartbeat, { target, clientId: 'tab-1' });
		await t.mutation(api.emailTemplates.emails.remove, { templateId });
		const left = await t.run(async (ctx) => [
			...(await ctx.db.query('emailCoeditSessions').collect()),
			...(await ctx.db.query('emailEditorPresence').collect()),
		]);
		expect(left).toEqual([]);
	});
});
