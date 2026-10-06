/**
 * IMAP folder membership (#927): the UID blocks behind the IMAP server's
 * sequence map stay exactly the folder's UIDs through every write path, a
 * backfill that races those writes, an interrupted backfill, and a rebuild.
 *
 * The invariant checked after every step: a ready folder's blocks, read in
 * order, are its `mailMessages` UIDs ascending; a folder still walking holds
 * exactly the rows at or before its watermark. And the revision moves on every
 * write that changes which UIDs a folder holds, and on nothing else, because
 * the IMAP server reuses a cached map for as long as it has not moved.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import type { Doc, Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import { internal } from '../../_generated/api';
import { makeFunctionReference } from 'convex/server';
import crons from '../../crons';
import { modules, seedFolder, seedMailbox, seedMessage } from './helpers.testlib';
import { insertDeliveredMessage } from '../deliveryPipeline/insert';
import { moveMessagesToFolder } from '../messageActions';
import { purgeMessageRow } from '../messagePurge';
import {
	MEMBERSHIP_BLOCK_SIZE,
	dropFolderMembership,
	resetFolderMembership,
	loadFolderMembership,
	readMembershipBlocks,
	recordFolderMembership,
	runFolderMembershipBackfillStep,
	startFolderMembership,
} from '../folderMembership';
import { isCountedPosition } from '../../lib/counters';
import { IMAP_WIRE_VERSION } from '@owlat/shared/imapWire';

type Test = TestConvex<typeof schema>;
type RunCtx = Parameters<Parameters<Test['run']>[0]>[0];

/** Deterministic PRNG (mulberry32), so a failing seed replays exactly. */
function rng(seed: number) {
	let a = seed >>> 0;
	const next = () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	return {
		int: (n: number) => Math.floor(next() * n),
		pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!,
		chance: (p: number) => next() < p,
	};
}
type Rng = ReturnType<typeof rng>;

interface World {
	t: Test;
	mailboxId: Id<'mailboxes'>;
	folderIds: Id<'mailFolders'>[];
}

async function setup(): Promise<World> {
	const t = convexTest(schema, modules);
	const mailboxId = await seedMailbox(t);
	const folderIds = [
		await seedFolder(t, mailboxId, 'inbox'),
		await seedFolder(t, mailboxId, 'archive'),
		await seedFolder(t, mailboxId, 'trash'),
	];
	return { t, mailboxId, folderIds };
}

async function deliver(ctx: RunCtx, w: World, folderId: Id<'mailFolders'>): Promise<void> {
	const mailbox = (await ctx.db.get(w.mailboxId))!;
	const folder = (await ctx.db.get(folderId))!;
	const rawStorageId = await ctx.storage.store(new Blob(['raw']));
	await insertDeliveredMessage(ctx, {
		mailbox,
		folder,
		rawStorageId,
		rawSize: 3,
		from: 'sender@example.com',
		to: ['a@owlat.test'],
		cc: [],
		bcc: [],
		subject: 'hello',
		textBodyInline: 'body',
		messageId: `<m${Math.random()}@example.com>`,
		receivedAt: Date.now(),
		attachments: [],
	});
}

async function messagesIn(
	ctx: MutationCtx,
	folderId: Id<'mailFolders'>
): Promise<Doc<'mailMessages'>[]> {
	return ctx.db
		.query('mailMessages')
		.withIndex('by_folder_and_uid', (q) => q.eq('folderId', folderId))
		.collect();
}

/** What a folder's blocks hold, and what they should hold. */
async function membershipOf(ctx: MutationCtx, folderId: Id<'mailFolders'>) {
	const state = await loadFolderMembership(ctx.db, folderId);
	const blocks = await readMembershipBlocks(ctx.db, folderId, undefined, 10_000);
	const rows = await messagesIn(ctx, folderId);
	const counted = !state
		? []
		: state.isReady
			? rows
			: rows.filter((m) =>
					isCountedPosition({ key: m.uid, creationTime: m._creationTime }, state.watermark)
				);
	return {
		state,
		blocks,
		stored: blocks.flatMap((b) => b.uids),
		expected: counted.map((m) => m.uid),
		all: rows.map((m) => m.uid),
	};
}

/** Run a folder's backfill to the end, `pageSize` rows per transaction. */
async function walkToReady(t: Test, folderId: Id<'mailFolders'>, pageSize?: number) {
	let hasMore = true;
	while (hasMore) {
		hasMore = await t.run((ctx) => runFolderMembershipBackfillStep(ctx, folderId, pageSize));
	}
}

async function expectMembershipExact(w: World, label: string): Promise<void> {
	for (const folderId of w.folderIds) {
		const m = await w.t.run((ctx) => membershipOf(ctx, folderId));
		if (!m.state) {
			expect(m.blocks, label).toEqual([]);
			continue;
		}
		expect(m.stored, label).toEqual(m.expected);
		// Structure: bounds ascending, every UID inside its block's bound and below
		// the next one, no empty and no oversized block.
		for (const [i, block] of m.blocks.entries()) {
			expect(block.uids.length, label).toBeGreaterThan(0);
			expect(block.uids.length, label).toBeLessThanOrEqual(MEMBERSHIP_BLOCK_SIZE);
			expect(block.uids[0]!, label).toBeGreaterThanOrEqual(block.firstUid);
			const next = m.blocks[i + 1];
			if (next) expect(block.uids[block.uids.length - 1]!, label).toBeLessThan(next.firstUid);
		}
	}
}

async function revisions(w: World): Promise<Array<number | null>> {
	return w.t.run(async (ctx) =>
		Promise.all(
			w.folderIds.map(async (id) => (await loadFolderMembership(ctx.db, id))?.revision ?? null)
		)
	);
}

async function uidsByFolder(w: World): Promise<string> {
	return w.t.run(async (ctx) =>
		JSON.stringify(
			await Promise.all(
				w.folderIds.map(async (id) => (await messagesIn(ctx, id)).map((m) => m.uid))
			)
		)
	);
}

/** One random write through a real write path. */
async function randomOp(w: World, r: Rng): Promise<void> {
	const { t } = w;
	const all = await t.run(async (ctx) =>
		(await Promise.all(w.folderIds.map((id) => messagesIn(ctx, id)))).flat()
	);
	const roll = r.int(9);
	if (all.length === 0 || roll === 0) {
		await t.run((ctx) => deliver(ctx, w, r.pick(w.folderIds)));
		return;
	}
	const m = r.pick(all);
	const other = r.pick(w.folderIds.filter((id) => id !== m.folderId));
	switch (roll) {
		case 1:
			await t.run((ctx) =>
				moveMessagesToFolder(ctx, { messageIds: [m._id], targetFolderId: other })
			);
			return;
		case 2:
			await t.run(async (ctx) => {
				await purgeMessageRow(ctx, m);
			});
			return;
		case 3:
			await t.mutation(internal.mail.imap.move.copyMessages, {
				sourceFolderId: m.folderId,
				targetFolderId: other,
				messageIds: [m._id],
			});
			return;
		case 4:
			await t.mutation(internal.mail.imap.move.moveMessages, {
				sourceFolderId: m.folderId,
				targetFolderId: other,
				messageIds: [m._id],
			});
			return;
		case 5:
			await t.mutation(internal.mail.imap.flags.storeFlags, {
				messageIds: [m._id],
				flags: ['\\Deleted'],
				mode: 'add',
			});
			await t.mutation(internal.mail.imap.move.expungeFolder, {
				folderId: m.folderId,
				imapWireVersion: IMAP_WIRE_VERSION,
			});
			return;
		case 6:
			// A flag write changes no membership: the revision must not move.
			await t.mutation(internal.mail.imap.flags.storeFlags, {
				messageIds: [m._id],
				flags: ['\\Seen'],
				mode: r.chance(0.5) ? 'add' : 'remove',
			});
			return;
		case 7: {
			const rawStorageId = await t.run((ctx) => ctx.storage.store(new Blob(['raw'])));
			await t.mutation(internal.mail.imap.append.appendMessage, {
				folderId: r.pick(w.folderIds),
				rawStorageId,
				rawSize: 3,
				rfc822MessageId: `<a${r.int(1e9)}@owlat.test>`,
				fromAddress: 'a@owlat.test',
				toAddresses: ['b@example.com'],
				ccAddresses: [],
				bccAddresses: [],
				subject: 'appended',
			});
			return;
		}
		default:
			await t.run((ctx) => deliver(ctx, w, r.pick(w.folderIds)));
	}
}

/** Run one random op and check the blocks and the revision contract after it. */
async function checkedOp(w: World, r: Rng, label: string): Promise<void> {
	const beforeUids = await uidsByFolder(w);
	const beforeRevisions = await revisions(w);
	await randomOp(w, r);
	await expectMembershipExact(w, label);
	const afterUids = JSON.parse(await uidsByFolder(w)) as number[][];
	const afterRevisions = await revisions(w);
	const before = JSON.parse(beforeUids) as number[][];
	for (const [i, revision] of afterRevisions.entries()) {
		const previous = beforeRevisions[i];
		if (revision === null || previous === null || previous === undefined) continue;
		const changed = JSON.stringify(before[i]) !== JSON.stringify(afterUids[i]);
		if (changed) expect(revision, `${label}: folder ${i} changed`).toBeGreaterThan(previous);
		else expect(revision, `${label}: folder ${i} unchanged`).toBe(previous);
	}
}

describe('folder membership equals the folder (#927)', () => {
	for (const seed of [3, 11, 58, 927]) {
		it(`stays exact through random writes and a racing backfill (seed ${seed})`, async () => {
			const r = rng(seed);
			const w = await setup();

			// Mail that predates the membership: nothing is maintained yet.
			for (let i = 0; i < 25; i++) await randomOp(w, r);
			await expectMembershipExact(w, 'before any state row');

			await w.t.run(async (ctx) => {
				for (const id of w.folderIds) await startFolderMembership(ctx, id);
			});

			// The walk advances three rows at a time while writes keep landing.
			let step = 0;
			let walking = true;
			while (walking) {
				step += 1;
				await checkedOp(w, r, `walk step ${step}`);
				walking = false;
				for (const id of w.folderIds) {
					if (await w.t.run((ctx) => runFolderMembershipBackfillStep(ctx, id, 3))) walking = true;
				}
				await expectMembershipExact(w, `walk step ${step} (page)`);
				expect(step).toBeLessThan(200);
			}
			const states = await w.t.run(async (ctx) =>
				Promise.all(w.folderIds.map((id) => loadFolderMembership(ctx.db, id)))
			);
			expect(states.map((s) => s?.isReady)).toEqual([true, true, true]);

			for (let i = 0; i < 40; i++) await checkedOp(w, r, `after ready, op ${i}`);
		});
	}

	it('a folder that starts empty is ready at once and kept exact from its first message', async () => {
		const w = await setup();
		await w.t.run(async (ctx) => {
			for (const id of w.folderIds) await startFolderMembership(ctx, id, { isEmpty: true });
		});
		const r = rng(5);
		for (let i = 0; i < 40; i++) await checkedOp(w, r, `op ${i}`);
	});

	it('the backfill does not move the revision', async () => {
		const w = await setup();
		for (let i = 0; i < 10; i++) await w.t.run((ctx) => deliver(ctx, w, w.folderIds[0]!));
		await w.t.run((ctx) => startFolderMembership(ctx, w.folderIds[0]!));
		await walkToReady(w.t, w.folderIds[0]!, 4);
		const state = await w.t.run((ctx) => loadFolderMembership(ctx.db, w.folderIds[0]!));
		expect(state).toMatchObject({ isReady: true, revision: 0, cursor: null });
		await expectMembershipExact(w, 'ready');
	});
});

describe('membership blocks', () => {
	async function folderWith(t: Test) {
		const mailboxId = await seedMailbox(t);
		const folderId = await seedFolder(t, mailboxId, 'inbox');
		await t.run((ctx) => startFolderMembership(ctx, folderId, { isEmpty: true }));
		return folderId;
	}
	const add = (folderId: Id<'mailFolders'>, uid: number) => (ctx: MutationCtx) =>
		recordFolderMembership(ctx, null, { folderId, uid });
	const remove = (folderId: Id<'mailFolders'>, uid: number) => (ctx: MutationCtx) =>
		recordFolderMembership(ctx, { folderId, uid }, null);
	const sizes = (t: Test, folderId: Id<'mailFolders'>) =>
		t.run(async (ctx) =>
			(await readMembershipBlocks(ctx.db, folderId, undefined, 100)).map((b) => b.uids.length)
		);

	it('appends fill a block and start the next one', async () => {
		const t = convexTest(schema, modules);
		const folderId = await folderWith(t);
		await t.run(async (ctx) => {
			for (let uid = 1; uid <= 600; uid++) await add(folderId, uid)(ctx);
		});
		expect(await sizes(t, folderId)).toEqual([256, 256, 88]);
	});

	it('an insert into a full block splits it in half and keeps the order', async () => {
		const t = convexTest(schema, modules);
		const folderId = await folderWith(t);
		await t.run(async (ctx) => {
			for (let uid = 2; uid <= 512; uid += 2) await add(folderId, uid)(ctx);
			await add(folderId, 101)(ctx);
		});
		expect(await sizes(t, folderId)).toEqual([128, 129]);
		const uids = await t.run(async (ctx) =>
			(await readMembershipBlocks(ctx.db, folderId, undefined, 100)).flatMap((b) => b.uids)
		);
		expect(uids).toEqual([...uids].sort((a, b) => a - b));
		expect(uids).toContain(101);
	});

	it('a UID below every block lowers the first bound', async () => {
		const t = convexTest(schema, modules);
		const folderId = await folderWith(t);
		await t.run(async (ctx) => {
			await add(folderId, 50)(ctx);
			await add(folderId, 7)(ctx);
		});
		const blocks = await t.run((ctx) => readMembershipBlocks(ctx.db, folderId, undefined, 10));
		expect(blocks.map((b) => [b.firstUid, b.uids])).toEqual([[7, [7, 50]]]);
	});

	it('scattered removals merge small blocks and delete empty ones', async () => {
		const t = convexTest(schema, modules);
		const folderId = await folderWith(t);
		await t.run(async (ctx) => {
			for (let uid = 1; uid <= 768; uid++) await add(folderId, uid)(ctx);
		});
		expect(await sizes(t, folderId)).toEqual([256, 256, 256]);
		await t.run(async (ctx) => {
			// Thin the last block to 40, then the middle one: when it drops below a
			// quarter (63) it absorbs the last block (63 + 40 fit in one).
			for (let uid = 513; uid <= 728; uid++) await remove(folderId, uid)(ctx);
			for (let uid = 257; uid <= 456; uid++) await remove(folderId, uid)(ctx);
		});
		expect(await sizes(t, folderId)).toEqual([256, 103 - 7]);
		await t.run(async (ctx) => {
			for (let uid = 1; uid <= 256; uid++) await remove(folderId, uid)(ctx);
		});
		// An emptied block is deleted outright.
		expect(await sizes(t, folderId)).toEqual([96]);
	});

	it('a UID two messages share (legacy data) is held twice and removed once', async () => {
		const t = convexTest(schema, modules);
		const folderId = await folderWith(t);
		await t.run(async (ctx) => {
			await add(folderId, 4)(ctx);
			await add(folderId, 4)(ctx);
			await remove(folderId, 4)(ctx);
		});
		const uids = await t.run(async (ctx) =>
			(await readMembershipBlocks(ctx.db, folderId, undefined, 10)).flatMap((b) => b.uids)
		);
		expect(uids).toEqual([4]);
	});

	it('a folder without a state row is not maintained', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		const folderId = await seedFolder(t, mailboxId, 'inbox');
		await t.run(add(folderId, 1));
		expect(await sizes(t, folderId)).toEqual([]);
	});
});

describe('mail/imap/fetch:folderMembershipPage', () => {
	it('answers null, then not-ready, then blocks, then unchanged for the known version', async () => {
		const w = await setup();
		const folderId = w.folderIds[0]!;
		for (let i = 0; i < 5; i++) await w.t.run((ctx) => deliver(ctx, w, folderId));
		const page = (knownVersion?: string) =>
			w.t.query(internal.mail.imap.fetch.folderMembershipPage, {
				folderId,
				...(knownVersion === undefined ? {} : { knownVersion }),
			});

		expect(await page()).toBeNull();
		await w.t.run((ctx) => startFolderMembership(ctx, folderId));
		const walking = await page();
		expect(walking).toMatchObject({ isReady: false });
		expect(walking).not.toHaveProperty('blocks');

		await walkToReady(w.t, folderId);
		const ready = await page();
		expect(ready).toMatchObject({ isReady: true, blocks: [[1, 2, 3, 4, 5]], nextFirstUid: null });
		// Ready did not change the membership, so the version is the walking one.
		expect(ready!.version).toBe(walking!.version);
		expect(await page(ready!.version)).toEqual({
			version: ready!.version,
			isReady: true,
			unchanged: true,
		});

		await w.t.run((ctx) => deliver(ctx, w, folderId));
		const moved = await page(ready!.version);
		expect(moved!.version).not.toBe(ready!.version);
		expect(moved).toMatchObject({ blocks: [[1, 2, 3, 4, 5, 6]] });
	});

	it('a dropped and rebuilt membership never repeats an old version', async () => {
		const w = await setup();
		const folderId = w.folderIds[0]!;
		await w.t.run((ctx) => startFolderMembership(ctx, folderId, { isEmpty: true }));
		const first = await w.t.query(internal.mail.imap.fetch.folderMembershipPage, { folderId });
		await w.t.run((ctx) => dropFolderMembership(ctx, folderId));
		await w.t.run((ctx) => startFolderMembership(ctx, folderId, { isEmpty: true }));
		const again = await w.t.query(internal.mail.imap.fetch.folderMembershipPage, {
			folderId,
			knownVersion: first!.version,
		});
		expect(again).not.toHaveProperty('unchanged');
		expect(again!.version).not.toBe(first!.version);
	});
});

describe('migration 0054 backfills, resumes and rebuilds', () => {
	vi.useFakeTimers();
	const migration = internal.migrations['0054_backfill_folder_membership'];

	async function seeded() {
		const w = await setup();
		for (const folderId of w.folderIds) {
			for (let i = 0; i < 7; i++) await w.t.run((ctx) => deliver(ctx, w, folderId));
		}
		return w;
	}

	async function runToEnd(w: World, args: { restart?: boolean; rebuild?: boolean } = {}) {
		const started = await w.t.mutation(migration.run, args);
		await w.t.finishAllScheduledFunctions(vi.runAllTimers);
		return started;
	}

	const versionOf = (w: World, folderId: Id<'mailFolders'>) =>
		w.t.run(async (ctx) => {
			const state = await loadFolderMembership(ctx.db, folderId);
			return state ? `${state._id}:${state.revision}` : null;
		});

	const readLedger = (ctx: RunCtx) =>
		ctx.db
			.query('migrationRuns')
			.withIndex('by_migration', (q) => q.eq('migration', '0054_backfill_folder_membership'))
			.unique();
	const ledger = (w: World) => w.t.run(readLedger);
	/** Nothing has moved the ledger row for over an hour, as when its chain died. */
	const stillForAnHour = (w: World) =>
		w.t.run(async (ctx) => {
			const row = (await readLedger(ctx))!;
			await ctx.db.patch(row._id, { updatedAt: Date.now() - 61 * 60_000 });
		});

	it('walks every folder to ready, then completes its ledger row', async () => {
		const w = await seeded();
		expect(await runToEnd(w)).toMatchObject({ started: true });
		expect(await w.t.query(migration.status, {})).toMatchObject({
			status: 'completed',
			foldersStarted: 3,
			ready: 3,
			walking: 0,
		});
		expect(await ledger(w)).toMatchObject({
			status: 'completed',
			introducedIn: '0.6.7',
			scannedCount: 3,
		});
		await expectMembershipExact(w, 'after 0054');
	});

	it('an interrupted walk resumes from its stored cursor without adding a UID twice', async () => {
		const w = await seeded();
		const folderId = w.folderIds[0]!;
		// A walk that got two pages in, then died (no step left queued).
		await w.t.run((ctx) => startFolderMembership(ctx, folderId));
		await w.t.run((ctx) => runFolderMembershipBackfillStep(ctx, folderId, 2));
		await w.t.run((ctx) => runFolderMembershipBackfillStep(ctx, folderId, 2));
		// Writes keep landing on both sides of the watermark meanwhile.
		await w.t.run((ctx) => deliver(ctx, w, folderId));
		const [first] = await w.t.run((ctx) => messagesIn(ctx, folderId));
		await w.t.run(async (ctx) => {
			await purgeMessageRow(ctx, first!);
		});
		await expectMembershipExact(w, 'interrupted');

		await runToEnd(w);
		await expectMembershipExact(w, 'resumed');
		expect(await w.t.query(migration.status, {})).toMatchObject({ status: 'completed', ready: 3 });
	});

	it('finish restarts a walk whose chain died, and completes only once it is ready', async () => {
		const w = await seeded();
		const { generation } = await w.t.mutation(migration.run, {});
		// The folder pass has not run; one folder's walk was started long ago and
		// its chain is gone.
		const folderId = w.folderIds[2]!;
		await w.t.run(async (ctx) => {
			await startFolderMembership(ctx, folderId);
			const state = (await loadFolderMembership(ctx.db, folderId))!;
			await ctx.db.patch(state._id, { updatedAt: Date.now() - 11 * 60_000 });
		});
		const first = await w.t.mutation(migration.finish, { cursor: null, generation: generation! });
		expect(first).toEqual({ isSuperseded: false, isCompleted: false });
		const kicked = await w.t.run(async (ctx) => (await loadFolderMembership(ctx.db, folderId))!);
		expect(kicked.updatedAt).toBeGreaterThan(Date.now() - 60_000);

		await w.t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(await w.t.query(migration.status, {})).toMatchObject({
			status: 'completed',
			walking: 0,
		});
		await expectMembershipExact(w, 'after the sweep');
	});

	it('a page from a superseded run does nothing', async () => {
		const w = await seeded();
		const { generation } = await w.t.mutation(migration.run, {});
		await w.t.mutation(migration.run, { restart: true });
		const stale = await w.t.mutation(migration.startPage, {
			cursor: null,
			generation: generation!,
		});
		expect(stale).toEqual({ isSuperseded: true });
	});

	it('a completed migration is left alone; restart passes again without touching ready folders', async () => {
		const w = await seeded();
		await runToEnd(w);
		const before = await versionOf(w, w.folderIds[0]!);
		expect(await runToEnd(w)).toMatchObject({ started: false });
		expect(await runToEnd(w, { restart: true })).toMatchObject({ started: true });
		expect(await versionOf(w, w.folderIds[0]!)).toBe(before);
		expect(await w.t.query(migration.status, {})).toMatchObject({ status: 'completed' });
	});

	describe('the ensure cron', () => {
		/** The registered cron entry, called the way the scheduler calls it. */
		const cron = (crons as unknown as { crons: Record<string, { name: string; args: unknown[] }> })
			.crons['ensure folder membership backfill'];
		const tick = (w: World) =>
			w.t.mutation(
				makeFunctionReference<'mutation', Record<string, never>, { started: boolean }>(cron!.name),
				cron!.args[0] as Record<string, never>
			);
		it('starts 0054 on a deployment that never ran it, until the IMAP server stops listing', async () => {
			expect(cron?.name).toBe('migrations/0054_backfill_folder_membership:ensure');
			const w = await seeded();
			// Unmigrated: the IMAP server would list every folder from mailMessages.
			for (const folderId of w.folderIds) {
				expect(await w.t.query(internal.mail.imap.fetch.folderMembershipPage, { folderId })).toBe(
					null
				);
			}
			expect(await tick(w)).toMatchObject({ started: true });
			await w.t.finishAllScheduledFunctions(vi.runAllTimers);

			expect(await w.t.query(migration.status, {})).toMatchObject({
				status: 'completed',
				ready: 3,
				walking: 0,
			});
			await expectMembershipExact(w, 'after the cron');
			for (const folderId of w.folderIds) {
				const page = await w.t.query(internal.mail.imap.fetch.folderMembershipPage, { folderId });
				expect(page).toMatchObject({ isReady: true });
				expect(page?.blocks?.flat()).toHaveLength(7);
			}
		});

		it('leaves a completed pass and a pass that is moving alone', async () => {
			const w = await seeded();
			await runToEnd(w);
			const completed = await ledger(w);
			expect(await tick(w)).toEqual({ started: false });
			expect(await ledger(w)).toEqual(completed);

			const fresh = await seeded();
			await fresh.t.mutation(migration.run, {});
			const moving = await ledger(fresh);
			expect(await tick(fresh)).toEqual({ started: false });
			// No resume: the queued chain keeps its generation.
			expect(await ledger(fresh)).toEqual(moving);
		});

		it('resumes a pass whose ledger has been still for an hour', async () => {
			const w = await seeded();
			const { generation } = await w.t.mutation(migration.run, {});
			// The chain died before its first page; nothing moved the row since.
			await stillForAnHour(w);
			expect(await tick(w)).toMatchObject({ started: true, generation: generation! + 1 });
			await w.t.finishAllScheduledFunctions(vi.runAllTimers);
			expect(await w.t.query(migration.status, {})).toMatchObject({
				status: 'completed',
				ready: 3,
			});
			await expectMembershipExact(w, 'resumed by the cron');
		});
	});

	it('rebuild repairs a membership found out of step and moves its version', async () => {
		const w = await seeded();
		await runToEnd(w);
		const folderId = w.folderIds[1]!;
		await w.t.run(async (ctx) => {
			const [block] = await readMembershipBlocks(ctx.db, folderId, undefined, 1);
			await ctx.db.patch(block!._id, { uids: block!.uids.slice(1) });
		});
		const broken = await w.t.run((ctx) => membershipOf(ctx, folderId));
		expect(broken.stored).not.toEqual(broken.expected);
		const before = await versionOf(w, folderId);

		await runToEnd(w, { rebuild: true });
		await expectMembershipExact(w, 'rebuilt');
		// An IMAP server that cached the broken blocks must not reuse them.
		expect(await versionOf(w, folderId)).not.toBe(before);
	});

	describe('an interrupted rebuild', () => {
		/**
		 * 101 ready, empty folders, so the folder pass takes two pages; the last
		 * folder, on the second page, holds a stray block no message backs. The
		 * rebuild's first page commits, then its chain dies.
		 */
		async function interruptedRebuild() {
			const w = await setup();
			while (w.folderIds.length < 101) {
				w.folderIds.push(await seedFolder(w.t, w.mailboxId, 'archive'));
			}
			const stray = w.folderIds[100]!;
			await w.t.run(async (ctx) => {
				for (const folderId of w.folderIds) {
					await startFolderMembership(ctx, folderId, { isEmpty: true });
				}
				await ctx.db.insert('mailFolderUidBlocks', {
					folderId: stray,
					firstUid: 999,
					uids: [999],
				});
			});
			const before = await versionOf(w, stray);
			expect(await w.t.mutation(migration.run, { rebuild: true })).toMatchObject({
				started: true,
			});
			// Exactly the first page: it resets 100 folders and queues the second.
			vi.advanceTimersToNextTimer();
			await w.t.finishInProgressScheduledFunctions();
			expect(await w.t.query(migration.status, {})).toMatchObject({
				status: 'running',
				foldersStarted: 100,
			});
			return { w, stray, before };
		}

		const strayUids = (w: World, folderId: Id<'mailFolders'>) =>
			w.t.run(async (ctx) =>
				(await readMembershipBlocks(ctx.db, folderId, undefined, 100)).flatMap((b) => b.uids)
			);

		it('resumed with no arguments, it goes on rebuilding the folders it had not reached', async () => {
			const { w, stray, before } = await interruptedRebuild();
			// The documented resume supersedes the dead chain.
			expect(await runToEnd(w)).toMatchObject({ started: true });

			expect(await w.t.query(migration.status, {})).toMatchObject({
				status: 'completed',
				foldersStarted: 101,
				walking: 0,
			});
			expect(await strayUids(w, stray)).toEqual([]);
			expect(await versionOf(w, stray)).not.toBe(before);
		});

		it('the ensure cron resumes it as a rebuild once its ledger has been still for an hour', async () => {
			const { w, stray, before } = await interruptedRebuild();
			expect(await w.t.mutation(migration.ensure, {})).toEqual({ started: false });
			await stillForAnHour(w);
			expect(await w.t.mutation(migration.ensure, {})).toMatchObject({ started: true });
			await w.t.finishAllScheduledFunctions(vi.runAllTimers);
			expect(await w.t.query(migration.status, {})).toMatchObject({
				status: 'completed',
				isRebuild: true,
				foldersStarted: 101,
			});
			expect(await strayUids(w, stray)).toEqual([]);
			expect(await versionOf(w, stray)).not.toBe(before);
		});

		it('a restart without rebuild is refused while the rebuild is unfinished', async () => {
			const { w, stray } = await interruptedRebuild();
			expect(await w.t.mutation(migration.run, { restart: true })).toMatchObject({
				started: false,
			});
			// The rebuild's own chain is untouched and still finishes the repair.
			await w.t.finishAllScheduledFunctions(vi.runAllTimers);
			expect(await w.t.query(migration.status, {})).toMatchObject({ status: 'completed' });
			expect(await strayUids(w, stray)).toEqual([]);
		});
	});
});

describe('resetFolderMembership', () => {
	it('clears the old blocks before the walk adds any', async () => {
		const w = await setup();
		const folderId = w.folderIds[0]!;
		await w.t.run((ctx) => startFolderMembership(ctx, folderId, { isEmpty: true }));
		for (let i = 0; i < 300; i++) await w.t.run((ctx) => deliver(ctx, w, folderId));
		await w.t.run(async (ctx) => {
			// A stray block no message backs, as a bug might leave.
			await ctx.db.insert('mailFolderUidBlocks', { folderId, firstUid: 9_999, uids: [9_999] });
			await resetFolderMembership(ctx, folderId);
		});
		// While walking, the folder reads as not ready: nobody uses the blocks.
		const page = await w.t.query(internal.mail.imap.fetch.folderMembershipPage, { folderId });
		expect(page).toMatchObject({ isReady: false });
		await walkToReady(w.t, folderId, 50);
		await expectMembershipExact(w, 'after reset');
	});
});

describe('membership follows folders and IMAP results', () => {
	it('expungeFolder reports the expunged UIDs and no sequence numbers', async () => {
		const w = await setup();
		const folderId = w.folderIds[0]!;
		for (let i = 0; i < 4; i++) await w.t.run((ctx) => deliver(ctx, w, folderId));
		const ids = (await w.t.run((ctx) => messagesIn(ctx, folderId))).map((m) => m._id);
		await w.t.mutation(internal.mail.imap.flags.storeFlags, {
			messageIds: [ids[1]!, ids[3]!],
			flags: ['\\Deleted'],
			mode: 'add',
		});
		const result = await w.t.mutation(internal.mail.imap.move.expungeFolder, {
			folderId,
			imapWireVersion: IMAP_WIRE_VERSION,
		});
		expect(result.uids).toEqual([4, 2]);
		// The IMAP server numbers `uids` against its client's view; the numbers
		// counted from the folder's total went with wire 0 (v0.6.7 and older).
		expect(result).not.toHaveProperty('sequenceNumbers');
		expect(result).not.toHaveProperty('nextSequenceNumber');
	});

	it('deleting a folder drops its membership', async () => {
		const w = await setup();
		const folderId = await w.t.run(async (ctx) => {
			const now = Date.now();
			const id = await ctx.db.insert('mailFolders', {
				mailboxId: w.mailboxId,
				name: 'Receipts',
				uidValidity: now,
				uidNext: 1,
				highestModseq: 1,
				totalCount: 0,
				unseenCount: 0,
				subscribed: true,
				createdAt: now,
				updatedAt: now,
			});
			await startFolderMembership(ctx, id, { isEmpty: true });
			return id;
		});
		await w.t.run((ctx) => deliver(ctx, w, folderId));
		await w.t.mutation(internal.mail.folders.relocateAndDeleteFolder, {
			folderId,
			inboxId: w.folderIds[0]!,
		});
		const left = await w.t.run(async (ctx) => ({
			state: await loadFolderMembership(ctx.db, folderId),
			blocks: await readMembershipBlocks(ctx.db, folderId, undefined, 10),
		}));
		expect(left).toEqual({ state: null, blocks: [] });
	});

	it('selectFolder returns the first unseen UID and never counts the messages below it', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		const folderId = await seedFolder(t, mailboxId, 'inbox');
		const ids = [
			await seedMessage(t, mailboxId, { subject: 'one', flagSeen: true }),
			await seedMessage(t, mailboxId, { subject: 'two', flagSeen: true }),
			await seedMessage(t, mailboxId, { subject: 'three' }),
		];
		await t.run(async (ctx) => {
			for (const [i, id] of ids.entries()) await ctx.db.patch(id, { uid: i + 1 });
		});
		// No count: the IMAP server numbers the UID against its own view.
		const result = await t.query(internal.mail.imap.session.selectFolder, { folderId });
		expect(result?.firstUnseenUid).toBe(3);
		expect(result).not.toHaveProperty('firstUnseenSeq');
	});

	it('selectFolder rejects the skipFirstUnseenSeq a refused wire 1 IMAP server sends', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		const folderId = await seedFolder(t, mailboxId, 'inbox');
		// v0.6.8 (wire 1) is below IMAP_WIRE_MIN_SUPPORTED: its logins are refused,
		// and a session it opened earlier gets an argument error on SELECT, which
		// as a read changes nothing.
		const wire1Args = { folderId, skipFirstUnseenSeq: true };
		await expect(t.query(internal.mail.imap.session.selectFolder, wire1Args)).rejects.toThrow(
			/skipFirstUnseenSeq/
		);
	});
});
