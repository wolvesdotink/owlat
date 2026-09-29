/**
 * The Postbox's maintained counts (plan 3.1) against a full scan.
 *
 * Property: after any sequence of the writes that move a message's counted
 * state — delivery, read/unread from the app and from IMAP STORE, labels on a
 * message and on a thread, moves, IMAP COPY / MOVE / EXPUNGE, snooze and wake,
 * purge — every counter bucket equals what a scan of the messages says. That
 * holds before a scope exists (no buckets at all), while its backfill walk is
 * part-way (exactly the rows at or before the watermark are counted), and once
 * it is ready (every row). The walk is driven a few rows at a time between the
 * writes, so writes land on both sides of the watermark.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import type { Doc, Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import { api, internal } from '../../_generated/api';
import { modules, seedFolder, seedMailbox } from './helpers.testlib';
import { insertDeliveredMessage } from '../deliveryPipeline/insert';
import { FolderFlagWrites, writeMessageFlags } from '../flagWrites';
import type { ThreadFlagDeltas } from '../threadAggregates';
import { applyLabelToMessage } from '../labelsMembership';
import { moveMessagesToFolder } from '../messageActions';
import { purgeMessageRow } from '../messagePurge';
import { runCounterBackfillStep } from '../../maintenance/counterBackfill';
import { isCountedPosition, loadCounterScope, startCounterScope } from '../../lib/counters';
import {
	arrivalBuckets,
	countFolderArrivalsSince,
	folderArrivalsScope,
	labelUnreadBuckets,
	labelUnreadScope,
	messagePosition,
	sectionUnreadBuckets,
	sectionUnreadScope,
	startEmptyMailboxCounters,
} from '../messageCounters';

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	const session = { userId: 'user-A', role: 'owner', activeOrganizationId: 'org-1' };
	return {
		...actual,
		requireOrgMember: vi.fn(async () => session),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn(async () => session),
		getBetterAuthSessionWithRole: vi.fn(async () => session),
	};
});

type Test = TestConvex<typeof schema>;
/** `t.run`'s ctx: a mutation ctx whose storage can also `store` a blob. */
type RunCtx = Parameters<Parameters<Test['run']>[0]>[0];
const HOUR = 60 * 60 * 1000;
const SECTIONS = [undefined, 'Team', 'Alerts'] as const;

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
		next,
		int: (n: number) => Math.floor(next() * n),
		pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!,
		chance: (p: number) => next() < p,
	};
}
type Rng = ReturnType<typeof rng>;

interface World {
	t: Test;
	mailboxId: Id<'mailboxes'>;
	inboxId: Id<'mailFolders'>;
	folderIds: Id<'mailFolders'>[];
	labelIds: Id<'mailLabels'>[];
	base: number;
}

async function setup(): Promise<World> {
	const t = convexTest(schema, modules);
	const mailboxId = await seedMailbox(t);
	const inboxId = await seedFolder(t, mailboxId, 'inbox');
	const archiveId = await seedFolder(t, mailboxId, 'archive');
	const trashId = await seedFolder(t, mailboxId, 'trash');
	const labelIds = await t.run(async (ctx) => {
		const now = Date.now();
		const ids: Id<'mailLabels'>[] = [];
		for (const name of ['Work', 'Clients', 'Later']) {
			ids.push(await ctx.db.insert('mailLabels', { mailboxId, name, createdAt: now }));
		}
		return ids;
	});
	return {
		t,
		mailboxId,
		inboxId,
		folderIds: [inboxId, archiveId, trashId],
		labelIds,
		base: Date.now() - 48 * HOUR,
	};
}

async function messagesOf(ctx: MutationCtx, w: World): Promise<Doc<'mailMessages'>[]> {
	return ctx.db
		.query('mailMessages')
		.withIndex('by_mailbox_and_received', (q) => q.eq('mailboxId', w.mailboxId))
		.collect();
}

async function deliver(ctx: RunCtx, w: World, r: Rng): Promise<void> {
	const mailbox = (await ctx.db.get(w.mailboxId))!;
	const folder = (await ctx.db.get(r.chance(0.75) ? w.inboxId : r.pick(w.folderIds)))!;
	const labels = w.labelIds.filter(() => r.chance(0.35));
	const rawStorageId = await ctx.storage.store(new Blob(['raw']));
	await insertDeliveredMessage(ctx, {
		mailbox,
		folder,
		rawStorageId,
		rawSize: 3,
		from: `sender${r.int(5)}@example.com`,
		to: ['a@owlat.test'],
		cc: [],
		bcc: [],
		subject: `subject ${r.int(1000)}`,
		textBodyInline: 'body',
		messageId: `<m${r.int(1e9)}@example.com>`,
		// A few repeated timestamps, so equal `receivedAt` keys meet the watermark.
		receivedAt: w.base + r.int(12) * 4 * HOUR + (r.chance(0.5) ? 0 : r.int(HOUR)),
		attachments: [],
		flagSeen: r.chance(0.4),
		...(labels.length > 0 ? { labelIds: labels } : {}),
		pinnedSection: r.pick(SECTIONS),
	});
}

/** One random write through a real write path. */
async function randomOp(w: World, r: Rng): Promise<void> {
	const { t } = w;
	const messages = await t.run((ctx) => messagesOf(ctx, w));
	const roll = r.int(13);
	if (messages.length === 0 || roll === 0) {
		await t.run((ctx) => deliver(ctx, w, r));
		return;
	}
	const m = r.pick(messages);
	switch (roll) {
		case 1:
		case 2:
			await t.run(async (ctx) => {
				const folders = new FolderFlagWrites(ctx);
				const threads: ThreadFlagDeltas = new Map();
				await writeMessageFlags(ctx, folders, threads, m, { seen: r.chance(0.5) });
				await folders.flush();
			});
			return;
		case 3:
			await t.run(async (ctx) => {
				await applyLabelToMessage(ctx, m, r.pick(w.labelIds), r.chance(0.6), Date.now());
			});
			return;
		case 4:
			await t.run(async (ctx) => {
				await moveMessagesToFolder(ctx, {
					messageIds: [m._id],
					targetFolderId: r.pick(w.folderIds),
				});
			});
			return;
		case 5:
			await t.run(async (ctx) => {
				await purgeMessageRow(ctx, m);
			});
			return;
		case 6:
			await t.mutation(api.mail.snooze.snoozeMany, {
				messageIds: [m._id],
				until: Date.now() + HOUR,
			});
			return;
		case 7:
			await t.mutation(api.mail.snooze.unsnoozeMany, { messageIds: [m._id] });
			return;
		case 8:
			await t.mutation(internal.mail.imap.flags.storeFlags, {
				messageIds: [m._id],
				flags: ['\\Seen'],
				mode: r.chance(0.5) ? 'add' : 'remove',
			});
			return;
		case 9: {
			const target = r.pick(w.folderIds.filter((id) => id !== m.folderId));
			await t.mutation(
				r.chance(0.5) ? internal.mail.imap.move.copyMessages : internal.mail.imap.move.moveMessages,
				{ sourceFolderId: m.folderId, targetFolderId: target, messageIds: [m._id] }
			);
			return;
		}
		case 10:
			await t.mutation(internal.mail.imap.flags.storeFlags, {
				messageIds: [m._id],
				flags: ['\\Deleted'],
				mode: 'add',
			});
			await t.mutation(internal.mail.imap.move.expungeFolder, { folderId: m.folderId });
			return;
		case 11:
			await t.mutation(api.mail.labels.toggleOnThread, {
				threadId: m.threadId,
				labelId: r.pick(w.labelIds),
				add: r.chance(0.6),
			});
			return;
		default:
			await t.run((ctx) => deliver(ctx, w, r));
	}
}

function tally(
	rows: readonly Doc<'mailMessages'>[],
	buckets: (m: Doc<'mailMessages'>) => readonly string[]
): Map<string, number> {
	const out = new Map<string, number>();
	for (const row of rows) {
		for (const bucket of buckets(row)) out.set(bucket, (out.get(bucket) ?? 0) + 1);
	}
	return out;
}

/** Every scope's buckets equal the scan of the rows it has counted so far. */
async function expectCountersMatchScan(w: World, label: string): Promise<void> {
	const { stored, expected } = await w.t.run(async (ctx) => {
		const all = await messagesOf(ctx, w);
		const inboxRows = all.filter((m) => m.folderId === w.inboxId);
		const scopes = [
			{ scope: labelUnreadScope(w.mailboxId), rows: all, buckets: labelUnreadBuckets },
			{ scope: sectionUnreadScope(w.inboxId), rows: inboxRows, buckets: sectionUnreadBuckets },
			{ scope: folderArrivalsScope(w.inboxId), rows: inboxRows, buckets: arrivalBuckets },
		];
		const stored: Record<string, Record<string, number>> = {};
		const expected: Record<string, Record<string, number>> = {};
		for (const { scope, rows, buckets } of scopes) {
			const state = await loadCounterScope(ctx.db, scope);
			const counted = !state
				? []
				: state.isReady
					? rows
					: rows.filter((m) => isCountedPosition(messagePosition(m), state.watermark));
			expected[scope] = Object.fromEntries(tally(counted, buckets));
			const bucketRows = await ctx.db
				.query('counterBuckets')
				.withIndex('by_scope_and_bucket', (q) => q.eq('scope', scope))
				.collect();
			stored[scope] = Object.fromEntries(bucketRows.map((b) => [b.bucket, b.count]));
		}
		return { stored, expected };
	});
	expect(stored, label).toEqual(expected);
}

async function isReady(w: World): Promise<boolean> {
	return w.t.run(async (ctx) => {
		for (const scope of [
			labelUnreadScope(w.mailboxId),
			sectionUnreadScope(w.inboxId),
			folderArrivalsScope(w.inboxId),
		]) {
			if (!(await loadCounterScope(ctx.db, scope))?.isReady) return false;
		}
		return true;
	});
}

describe('Postbox counters equal a full scan (plan 3.1)', () => {
	for (const seed of [1, 7, 42, 99, 2026]) {
		it(`stays exact through a random write sequence and a racing backfill (seed ${seed})`, async () => {
			const r = rng(seed);
			const w = await setup();

			// Mail that predates the counters: nothing is counted yet.
			for (let i = 0; i < 30; i++) await randomOp(w, r);
			await expectCountersMatchScan(w, 'before any scope exists');

			await w.t.run(async (ctx) => {
				await startCounterScope(ctx, 'mailLabelUnread', w.mailboxId);
				await startCounterScope(ctx, 'mailSectionUnread', w.inboxId);
				await startCounterScope(ctx, 'mailFolderArrivals', w.inboxId);
			});

			// The walk advances two rows at a time while writes keep landing.
			let step = 0;
			while (!(await isReady(w))) {
				step += 1;
				for (let i = 0; i < 2; i++) {
					await randomOp(w, r);
					await expectCountersMatchScan(w, `walk step ${step} (write ${i})`);
				}
				// One page per transaction, as the scheduled chain runs them.
				for (const scope of [
					labelUnreadScope(w.mailboxId),
					sectionUnreadScope(w.inboxId),
					folderArrivalsScope(w.inboxId),
				]) {
					await w.t.run((ctx) => runCounterBackfillStep(ctx, scope, 2));
				}
				await expectCountersMatchScan(w, `walk step ${step} (page)`);
				expect(step).toBeLessThan(500);
			}

			for (let i = 0; i < 40; i++) {
				await randomOp(w, r);
				await expectCountersMatchScan(w, `after ready, op ${i}`);
			}
		});
	}
});

describe('Postbox readers on the counters (plan 3.1)', () => {
	it('labels, sections and new mail read the counters once a mailbox starts counted', async () => {
		const w = await setup();
		await w.t.run((ctx) => startEmptyMailboxCounters(ctx, w.mailboxId, w.inboxId));
		await w.t.run(async (ctx) => {
			await ctx.db.insert('mailFilters', {
				mailboxId: w.mailboxId,
				name: 'team',
				isEnabled: true,
				priority: 0,
				conditions: [],
				actions: [{ type: 'pinToSection', sectionName: 'Team' }],
				stopProcessing: false,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});
		const r = rng(3);
		for (let i = 0; i < 60; i++) await randomOp(w, r);

		const scan = await w.t.run(async (ctx) => {
			const all = await messagesOf(ctx, w);
			const inboxUnread = all.filter(
				(m) => m.folderId === w.inboxId && !m.flagSeen && m.snoozedUntil == null
			);
			return {
				labels: Object.fromEntries(tally(all, labelUnreadBuckets)),
				team: inboxUnread.filter((m) => m.pinnedSection === 'Team').length,
				rest: inboxUnread.filter((m) => m.pinnedSection !== 'Team').length,
				inboxReceived: all.filter((m) => m.folderId === w.inboxId).map((m) => m.receivedAt),
			};
		});

		const labels = await w.t.query(api.mail.labels.unreadCounts, { mailboxId: w.mailboxId });
		expect(labels).toEqual({ counts: scan.labels, isTruncated: false });

		const { sections } = await w.t.query(api.mail.sections.listSections, {
			mailboxId: w.mailboxId,
		});
		expect(sections.map((s) => [s.name, s.unreadCount, s.isUnreadCapped])).toEqual([
			['Team', scan.team, false],
			[null, scan.rest, false],
		]);

		for (const since of [w.base - HOUR, w.base + 7 * HOUR + 17, w.base + 30 * HOUR, Date.now()]) {
			const expected = scan.inboxReceived.filter((at) => at > since).length;
			const counted = await w.t.run((ctx) =>
				countFolderArrivalsSince(ctx.db, w.inboxId, since, 150)
			);
			expect(counted, `since ${since}`).toEqual({
				count: Math.min(expected, 150),
				isCapped: expected > 150,
			});
			const capped = await w.t.run((ctx) => countFolderArrivalsSince(ctx.db, w.inboxId, since, 3));
			expect(capped).toEqual({ count: Math.min(expected, 3), isCapped: expected > 3 });
		}
	});

	it('keeps the bounded scan until the scope is ready', async () => {
		const w = await setup();
		const r = rng(11);
		for (let i = 0; i < 10; i++) await w.t.run((ctx) => deliver(ctx, w, r));
		await w.t.run((ctx) => startCounterScope(ctx, 'mailFolderArrivals', w.inboxId));
		expect(await w.t.run((ctx) => countFolderArrivalsSince(ctx.db, w.inboxId, 0, 150))).toBeNull();
		const labels = await w.t.query(api.mail.labels.unreadCounts, { mailboxId: w.mailboxId });
		const scan = await w.t.run(async (ctx) =>
			Object.fromEntries(tally(await messagesOf(ctx, w), labelUnreadBuckets))
		);
		expect(labels).toEqual({ counts: scan, isTruncated: false });
	});
});
