/**
 * The order queued write-backs reach the provider in (mail/external/remoteOpOrder.ts).
 *
 * A failed op is backed off; nothing newer for the same message may overtake
 * it and then be undone by its retry. Pinned here:
 *   - a newer flag change supersedes the same flags in older queued ops, and
 *     ops recorded before that rule existed still run oldest first;
 *   - a move, or anything after it, waits for the older ops of its message;
 *   - a backed-off message holds back only itself, across page boundaries and
 *     across a drain cut short by a lost connection;
 *   - a folder rename or delete waits for the message ops that name the folder
 *     by its current remote name, and for older folder ops on its branch;
 *   - a queue longer than one read covers still drains: held ops at the front
 *     hand out what they wait for, and ops waiting for a failed op are pushed
 *     back with it.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import type { Doc, Id } from '../../_generated/dataModel';
import { api, internal } from '../../_generated/api';
import { enqueueRemoteOp } from '../external/remoteOps';
import { modules, seedFolder, seedMailbox, seedMessage } from './helpers.testlib';

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	const session = { userId: 'user-A', role: 'owner' as const, activeOrganizationId: 'org-1' };
	return {
		...actual,
		requireOrgMember: vi.fn(async () => session),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn(async () => session),
		getBetterAuthSessionWithRole: vi.fn(async () => session),
	};
});

type T = TestConvex<typeof schema>;
type QueuedOp = Parameters<typeof enqueueRemoteOp>[2];

async function externalMailbox() {
	const t = convexTest(schema, modules);
	const mailboxId = await seedMailbox(t, { kind: 'external' });
	for (const role of ['inbox', 'archive', 'trash'] as const) await seedFolder(t, mailboxId, role);
	const accountId = await t.run(async (ctx) => {
		const now = Date.now();
		const id = await ctx.db.insert('externalMailAccounts', {
			userId: 'user-A',
			organizationId: 'org-1',
			mailboxId,
			imapHost: 'imap.example',
			imapPort: 993,
			isImapSecure: true,
			smtpHost: 'smtp.example',
			smtpPort: 465,
			isSmtpSecure: true,
			authMethod: 'password',
			imapUsername: 'a@owlat.test',
			status: 'connected',
			createdAt: now,
			updatedAt: now,
		});
		await ctx.db.patch(mailboxId, { externalAccountId: id });
		return id;
	});
	return { t, mailboxId, accountId };
}

async function listDue(t: T, accountId: Id<'externalMailAccounts'>) {
	return await t.query(internal.mail.external.remoteOps.listDueRemoteOps, { accountId });
}

async function settle(
	t: T,
	results: Array<{ opId: Id<'externalMailRemoteOps'>; outcome: 'done' | 'not_found' | 'failed' }>
) {
	await t.mutation(internal.mail.external.remoteOps.settleRemoteOps, {
		results: results.map((r) => (r.outcome === 'failed' ? { ...r, error: 'NO [UNAVAILABLE]' } : r)),
	});
}

async function queuedRows(t: T): Promise<Doc<'externalMailRemoteOps'>[]> {
	return await t.run(async (ctx) => ctx.db.query('externalMailRemoteOps').collect());
}

/** The id of the one queued op matching `match`. */
async function opId(t: T, match: (row: Doc<'externalMailRemoteOps'>) => boolean) {
	const rows = (await queuedRows(t)).filter(match);
	if (rows.length !== 1) throw new Error(`expected one matching op, found ${rows.length}`);
	return rows[0]!._id;
}

/** Bring every backed-off op due again, as if the backoff had elapsed. */
async function elapseBackoff(t: T) {
	await t.run(async (ctx) => {
		for (const row of await ctx.db.query('externalMailRemoteOps').collect()) {
			await ctx.db.patch(row._id, { nextAttemptAt: Date.now() - 1 });
		}
	});
}

async function enqueue(t: T, accountId: Id<'externalMailAccounts'>, op: QueuedOp) {
	await t.run(async (ctx) => enqueueRemoteOp(ctx, accountId, op));
}

/** A row as the queue held it before ordering existed: no supersession, due at once. */
async function insertLegacy(t: T, accountId: Id<'externalMailAccounts'>, op: QueuedOp) {
	await t.run(async (ctx) => {
		const now = Date.now();
		await ctx.db.insert('externalMailRemoteOps', {
			...op,
			accountId,
			attempts: 0,
			nextAttemptAt: now,
			createdAt: now,
		});
	});
}

const flagsOp = (id: string, flags: QueuedOp['flags']): QueuedOp => ({
	kind: 'flags',
	rfc822MessageId: id,
	source: { role: 'inbox' },
	flags,
});

const moveOp = (id: string, source: QueuedOp['source'], target: QueuedOp['target']): QueuedOp => ({
	kind: 'move',
	rfc822MessageId: id,
	source,
	target,
});

describe('flag changes on one message', () => {
	it('lets a newer "mark unread" replace a failed older "mark read" instead of racing it', async () => {
		const { t, mailboxId, accountId } = await externalMailbox();
		const id = await seedMessage(t, mailboxId, { rfc822MessageId: 'a@x.example' });

		await t.mutation(api.mail.messageActions.setFlags, { messageIds: [id], seen: true });
		const [read] = await listDue(t, accountId);
		await settle(t, [{ opId: read!.opId, outcome: 'failed' }]);
		await t.mutation(api.mail.messageActions.setFlags, { messageIds: [id], seen: false });

		// The read retry is gone: the only value left to send is the latest.
		expect((await queuedRows(t)).map((r) => r.flags)).toEqual([{ seen: false }]);
		expect((await listDue(t, accountId)).map((op) => op.flags)).toEqual([{ seen: false }]);
	});

	it('keeps the flags a newer change does not touch, and sends both without waiting', async () => {
		const { t, accountId } = await externalMailbox();
		await enqueue(t, accountId, flagsOp('a@x.example', { seen: true, flagged: true }));
		const [older] = await listDue(t, accountId);
		await settle(t, [{ opId: older!.opId, outcome: 'failed' }]);

		await enqueue(t, accountId, flagsOp('a@x.example', { seen: false }));

		const rows = await queuedRows(t);
		expect(rows.map((r) => r.flags)).toEqual([{ flagged: true }, { seen: false }]);
		// The older op is still backed off; the newer one touches another flag and runs now.
		expect((await listDue(t, accountId)).map((op) => op.flags)).toEqual([{ seen: false }]);
	});

	it('keeps a change to another copy of the message, and sends it after the first', async () => {
		const { t, mailboxId, accountId } = await externalMailbox();
		const inInbox = await seedMessage(t, mailboxId, { rfc822MessageId: 'a@x.example' });
		const inArchive = await seedMessage(t, mailboxId, {
			rfc822MessageId: 'a@x.example',
			role: 'archive',
		});

		await t.mutation(api.mail.messageActions.setFlags, {
			messageIds: [inInbox, inArchive],
			seen: true,
		});

		expect((await queuedRows(t)).map((r) => r.source)).toEqual([
			{ role: 'inbox' },
			{ role: 'archive' },
		]);
		expect((await listDue(t, accountId)).map((op) => op.source)).toEqual([{ role: 'inbox' }]);
	});

	it('runs opposite changes queued before supersession existed oldest first', async () => {
		const { t, accountId } = await externalMailbox();
		await insertLegacy(t, accountId, flagsOp('a@x.example', { seen: true }));
		await insertLegacy(t, accountId, flagsOp('a@x.example', { seen: false }));
		const read = await opId(t, (r) => r.flags?.seen === true);
		const unread = await opId(t, (r) => r.flags?.seen === false);

		expect((await listDue(t, accountId)).map((op) => op.opId)).toEqual([read]);
		await settle(t, [{ opId: read, outcome: 'failed' }]);
		// The unread change must not run while the read retry is still to come.
		expect(await listDue(t, accountId)).toEqual([]);

		await elapseBackoff(t);
		expect((await listDue(t, accountId)).map((op) => op.opId)).toEqual([read]);
		await settle(t, [{ opId: read, outcome: 'done' }]);
		expect((await listDue(t, accountId)).map((op) => op.opId)).toEqual([unread]);
	});
});

describe('moves', () => {
	it('holds a newer move until the failed older one settles', async () => {
		const { t, mailboxId, accountId } = await externalMailbox();
		const id = await seedMessage(t, mailboxId, { rfc822MessageId: 'a@x.example' });

		await t.mutation(api.mail.messageActions.archive, { messageIds: [id] });
		const [archive] = await listDue(t, accountId);
		await settle(t, [{ opId: archive!.opId, outcome: 'failed' }]);
		await t.mutation(api.mail.messageActions.trash, { messageIds: [id] });
		const trash = await opId(t, (r) => r._id !== archive!.opId);

		expect(await listDue(t, accountId)).toEqual([]);
		// Not due before the op it waits behind, so it does not crowd the front of the queue.
		const rows = await queuedRows(t);
		expect(rows.find((r) => r._id === trash)!.nextAttemptAt).toBe(
			rows.find((r) => r._id === archive!.opId)!.nextAttemptAt
		);

		await elapseBackoff(t);
		expect((await listDue(t, accountId)).map((op) => op.opId)).toEqual([archive!.opId]);
		await settle(t, [{ opId: archive!.opId, outcome: 'done' }]);
		expect(await listDue(t, accountId)).toMatchObject([
			{ opId: trash, source: { role: 'archive' }, target: { role: 'trash' } },
		]);
	});

	it('holds a flag change behind an older move of its message', async () => {
		const { t, accountId } = await externalMailbox();
		await insertLegacy(
			t,
			accountId,
			moveOp('a@x.example', { role: 'inbox' }, { path: ['Receipts'] })
		);
		await insertLegacy(t, accountId, {
			...flagsOp('a@x.example', { seen: true }),
			source: { path: ['Receipts'] },
		});

		expect((await listDue(t, accountId)).map((op) => op.kind)).toEqual(['move']);
	});

	it('pushes the ops waiting behind a failed op back with it', async () => {
		const { t, accountId } = await externalMailbox();
		await insertLegacy(t, accountId, moveOp('a@x.example', { role: 'inbox' }, { role: 'archive' }));
		await insertLegacy(t, accountId, moveOp('a@x.example', { role: 'archive' }, { role: 'trash' }));
		const [first] = await listDue(t, accountId);

		await settle(t, [{ opId: first!.opId, outcome: 'failed' }]);

		const [a, b] = await queuedRows(t);
		expect(a!.nextAttemptAt).toBeGreaterThan(Date.now());
		expect(b!.nextAttemptAt).toBe(a!.nextAttemptAt);
	});
});

describe('other messages keep moving', () => {
	it('hands out an unrelated message while another one is backed off', async () => {
		const { t, accountId } = await externalMailbox();
		await enqueue(t, accountId, moveOp('a@x.example', { role: 'inbox' }, { role: 'archive' }));
		const [stuck] = await listDue(t, accountId);
		await settle(t, [{ opId: stuck!.opId, outcome: 'failed' }]);
		await insertLegacy(t, accountId, moveOp('a@x.example', { role: 'archive' }, { role: 'trash' }));
		await enqueue(t, accountId, moveOp('b@x.example', { role: 'inbox' }, { role: 'archive' }));

		expect((await listDue(t, accountId)).map((op) => op.rfc822MessageId)).toEqual(['b@x.example']);
	});

	it('does not hand out a held op on the next page once the op ahead of it failed', async () => {
		const { t, accountId } = await externalMailbox();
		for (let i = 0; i < 48; i++) {
			await insertLegacy(
				t,
				accountId,
				moveOp(`m${i}@x.example`, { role: 'inbox' }, { role: 'archive' })
			);
		}
		await insertLegacy(t, accountId, flagsOp('a@x.example', { seen: true }));
		await insertLegacy(t, accountId, flagsOp('a@x.example', { seen: false }));
		await insertLegacy(t, accountId, moveOp('y@x.example', { role: 'inbox' }, { role: 'archive' }));
		await insertLegacy(t, accountId, moveOp('z@x.example', { role: 'inbox' }, { role: 'archive' }));

		// The held unread change gives its place on the first page to the next message.
		const first = await listDue(t, accountId);
		expect(first).toHaveLength(50);
		expect(first.filter((op) => op.rfc822MessageId === 'a@x.example')).toMatchObject([
			{ flags: { seen: true } },
		]);
		expect(first[first.length - 1]!.rfc822MessageId).toBe('y@x.example');
		await settle(
			t,
			first.map((op) => ({
				opId: op.opId,
				outcome: op.rfc822MessageId === 'a@x.example' ? ('failed' as const) : ('done' as const),
			}))
		);

		// The unread change waits for the read retry; the message behind it does not.
		expect((await listDue(t, accountId)).map((op) => op.rfc822MessageId)).toEqual(['z@x.example']);
	});

	it('hands the same op out again after a drain the connection cut short', async () => {
		const { t, accountId } = await externalMailbox();
		await enqueue(t, accountId, moveOp('a@x.example', { role: 'inbox' }, { role: 'archive' }));
		const [first] = await listDue(t, accountId);

		// The worker lost its connection before settling; meanwhile the member trashed the message.
		await enqueue(t, accountId, moveOp('a@x.example', { role: 'archive' }, { role: 'trash' }));

		expect((await listDue(t, accountId)).map((op) => op.opId)).toEqual([first!.opId]);
	});
});

describe('folder renames and deletes', () => {
	const rename = (remote: string, name: string): QueuedOp => ({
		kind: 'renameFolder',
		source: { remote },
		target: { path: [name] },
	});

	it('waits for the message ops that name the folder, older or newer', async () => {
		const { t, accountId } = await externalMailbox();
		await enqueue(t, accountId, moveOp('a@x.example', { role: 'inbox' }, { remote: 'Receipts' }));
		await enqueue(t, accountId, rename('Receipts', 'Invoices'));
		await enqueue(t, accountId, moveOp('b@x.example', { remote: 'Receipts' }, { role: 'archive' }));

		const first = await listDue(t, accountId);
		expect(first.map((op) => op.kind)).toEqual(['move', 'move']);

		await settle(
			t,
			first.map((op) => ({ opId: op.opId, outcome: 'done' as const }))
		);
		expect((await listDue(t, accountId)).map((op) => op.kind)).toEqual(['renameFolder']);
	});

	it('waits for a message op naming a folder below it, but not for unrelated ones', async () => {
		const { t, accountId } = await externalMailbox();
		await enqueue(
			t,
			accountId,
			moveOp('a@x.example', { role: 'inbox' }, { remote: 'Clients/Acme' })
		);
		await enqueue(
			t,
			accountId,
			moveOp('b@x.example', { role: 'inbox' }, { remote: 'Clientsfolder' })
		);
		await enqueue(t, accountId, { kind: 'deleteFolder', source: { remote: 'Clients' } });
		await enqueue(t, accountId, { kind: 'deleteFolder', source: { remote: 'Receipts' } });

		const due = await listDue(t, accountId);
		expect(due.map((op) => [op.kind, op.source])).toEqual([
			['move', { role: 'inbox' }],
			['move', { role: 'inbox' }],
			['deleteFolder', { remote: 'Receipts' }],
		]);
	});

	it('runs folder ops on one branch in the order they were made', async () => {
		const { t, accountId } = await externalMailbox();
		await enqueue(t, accountId, rename('Clients', 'Customers'));
		await enqueue(t, accountId, { kind: 'deleteFolder', source: { remote: 'Clients' } });

		const [first, ...rest] = await listDue(t, accountId);
		expect(first!.kind).toBe('renameFolder');
		expect(rest).toEqual([]);

		await settle(t, [{ opId: first!.opId, outcome: 'done' }]);
		expect((await listDue(t, accountId)).map((op) => op.kind)).toEqual(['deleteFolder']);
	});
});

// Hundreds of rows polled to empty: seconds on its own, far more in a loaded full run.
describe('a long queue keeps draining', { timeout: 60_000 }, () => {
	type Row = Omit<Doc<'externalMailRemoteOps'>, '_id' | '_creationTime' | 'accountId'>;
	const row = (op: QueuedOp, nextAttemptAt: number): Row => ({
		...op,
		attempts: 0,
		nextAttemptAt,
		createdAt: nextAttemptAt,
	});
	const renameRow = (remote: string, at: number) =>
		row({ kind: 'renameFolder', source: { remote }, target: { path: [`${remote} (old)`] } }, at);

	async function insertRows(t: T, accountId: Id<'externalMailAccounts'>, rows: Row[]) {
		await t.run(async (ctx) => {
			for (const r of rows) await ctx.db.insert('externalMailRemoteOps', { ...r, accountId });
		});
	}

	/**
	 * Poll and settle like the worker until nothing is due, checking each page:
	 * a folder op is only handed out once no message op naming its folder is queued.
	 */
	async function drain(
		t: T,
		accountId: Id<'externalMailAccounts'>,
		outcome: (op: { kind: string }) => 'done' | 'failed' = () => 'done'
	) {
		const handedOut: string[] = [];
		for (let poll = 0; poll < 100; poll++) {
			const ops = await listDue(t, accountId);
			if (ops.length === 0) return handedOut;
			const queued = await queuedRows(t);
			for (const op of ops) {
				handedOut.push(op.kind);
				if (op.kind !== 'renameFolder' || !('remote' in op.source)) continue;
				const folder = op.source.remote;
				const naming = queued.filter(
					(r) =>
						r.rfc822MessageId !== undefined &&
						[r.source, r.target].some((ref) => ref && 'remote' in ref && ref.remote === folder)
				);
				expect(naming).toEqual([]);
			}
			await settle(
				t,
				ops.map((op) => ({ opId: op.opId, outcome: outcome(op) }))
			);
		}
		throw new Error('the queue did not drain');
	}

	it('runs folder ops and unrelated message ops past the read limits', async () => {
		const { t, accountId } = await externalMailbox();
		await insertRows(t, accountId, [
			...Array.from({ length: 520 }, (_, i) => renameRow(`Folder ${i}`, 1)),
			...Array.from({ length: 251 }, (_, i) => row(flagsOp(`m${i}@x.example`, { seen: true }), 2)),
		]);

		expect(await listDue(t, accountId)).toHaveLength(50);
		const handedOut = await drain(t, accountId);

		expect(handedOut.filter((kind) => kind === 'renameFolder')).toHaveLength(520);
		expect(handedOut.filter((kind) => kind === 'flags')).toHaveLength(251);
		expect(await queuedRows(t)).toEqual([]);
	});

	it('hands out the message ops that held folder ops at the front wait for', async () => {
		const { t, accountId } = await externalMailbox();
		// Every rename waits for a move into its folder, queued behind all the renames.
		await insertRows(t, accountId, [
			...Array.from({ length: 260 }, (_, i) => renameRow(`Folder ${i}`, 1)),
			...Array.from({ length: 260 }, (_, i) =>
				row(moveOp(`a${i}@x.example`, { role: 'inbox' }, { remote: `Folder ${i}/Sub` }), 2)
			),
			...Array.from({ length: 60 }, (_, i) => row(flagsOp(`m${i}@x.example`, { seen: true }), 3)),
		]);

		expect((await listDue(t, accountId)).map((op) => op.kind)).toEqual(Array(50).fill('move'));
		const handedOut = await drain(t, accountId);

		expect(handedOut.filter((kind) => kind === 'move')).toHaveLength(260);
		expect(handedOut.filter((kind) => kind === 'renameFolder')).toHaveLength(260);
		expect(handedOut.filter((kind) => kind === 'flags')).toHaveLength(60);
	});

	it('pushes the folder ops waiting for a failed message op back with it', async () => {
		const { t, accountId } = await externalMailbox();
		await insertRows(t, accountId, [
			...Array.from({ length: 260 }, (_, i) => renameRow(`Folder ${i}`, 1)),
			...Array.from({ length: 260 }, (_, i) =>
				row(moveOp(`a${i}@x.example`, { role: 'inbox' }, { remote: `Folder ${i}` }), 2)
			),
			row(flagsOp('b@x.example', { seen: true }), 3),
		]);

		// Every move fails and is backed off; the renames waiting for them go back too.
		let failed = 0;
		while (failed < 260) {
			const moves = (await listDue(t, accountId)).filter((op) => op.kind === 'move');
			expect(moves).not.toEqual([]);
			await settle(
				t,
				moves.map((op) => ({ opId: op.opId, outcome: 'failed' as const }))
			);
			failed += moves.length;
		}

		expect((await listDue(t, accountId)).map((op) => op.rfc822MessageId)).toEqual(['b@x.example']);
		const renames = (await queuedRows(t)).filter((r) => r.kind === 'renameFolder');
		expect(renames.every((r) => r.nextAttemptAt > Date.now())).toBe(true);
	});

	it('pushes every later op of a failed message back, however many are queued', async () => {
		const { t, accountId } = await externalMailbox();
		const folders = ['archive', 'inbox'] as const;
		await insertRows(t, accountId, [
			...Array.from({ length: 300 }, (_, i) =>
				row(moveOp('a@x.example', { role: folders[i % 2]! }, { role: folders[(i + 1) % 2]! }), 1)
			),
			row(flagsOp('b@x.example', { seen: true }), 2),
		]);
		const [first, ...rest] = await listDue(t, accountId);
		expect(first!.rfc822MessageId).toBe('a@x.example');
		expect(rest.map((op) => op.rfc822MessageId)).toEqual([]);

		await settle(t, [{ opId: first!.opId, outcome: 'failed' }]);

		expect((await listDue(t, accountId)).map((op) => op.rfc822MessageId)).toEqual(['b@x.example']);
	});
});
