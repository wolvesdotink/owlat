/**
 * The IMAP read path must never read a folder in one go.
 *
 * `listFolderUids` used to `.collect()` every `mailMessages` document in the
 * SELECTed folder — full rows, attachment metadata and all — on EVERY FETCH,
 * STORE and IDLE tick, only to return the sorted UID array. Convex caps one
 * function execution at 16,384 documents / 8 MiB, so on a real INBOX that is
 * not a slow query, it is a query that fails. The same shape answered
 * CONDSTORE: read a UID window, then drop the unchanged rows in JS, while
 * `by_folder_and_modseq` sat unused.
 *
 * These tests pin the replacements: UID listing and envelope reads page (and
 * report where to resume), and "what changed since modseq N" is served off the
 * modseq index — so its cost tracks the change set, not the folder.
 */

import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import schema from '../../schema';
import { modules, seedFolder, seedMailbox, seedMessage } from './helpers.testlib';

type Seeded = { folderId: Id<'mailFolders'>; messageIds: Id<'mailMessages'>[] };

/**
 * Seed `count` messages in one folder with UIDs 1..count. `seedMessage` always
 * writes uid/modseq 1, so the UID (and an optional modseq) is patched on after.
 */
async function seedFolderWithMessages(
	t: ReturnType<typeof convexTest>,
	count: number,
	modseqFor: (uid: number) => number = () => 1
): Promise<Seeded> {
	const mailboxId = await seedMailbox(t);
	const folderId = await seedFolder(t, mailboxId, 'inbox');
	const messageIds: Id<'mailMessages'>[] = [];
	for (let uid = 1; uid <= count; uid += 1) {
		const id = await seedMessage(t, mailboxId, { subject: `m${uid}` });
		await t.run(async (ctx) => {
			await ctx.db.patch(id, { uid, modseq: modseqFor(uid) });
		});
		messageIds.push(id);
	}
	return { folderId, messageIds };
}

describe('IMAP UID listing pages instead of collecting the folder', () => {
	it('walks a folder larger than one page, ascending and without gaps or repeats', async () => {
		const t = convexTest(schema, modules);
		const { folderId } = await seedFolderWithMessages(t, 12);

		const uids: number[] = [];
		const pageSizes: number[] = [];
		let afterUid: number | undefined;
		for (let guard = 0; guard < 10; guard += 1) {
			const page = await t.query(internal.mail.imap.fetch.listFolderUidsPage, {
				folderId,
				limit: 5,
				...(afterUid === undefined ? {} : { afterUid }),
			});
			pageSizes.push(page.uids.length);
			uids.push(...page.uids);
			if (page.nextUid === null) break;
			afterUid = page.nextUid;
		}

		expect(uids).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
		// Three reads of at most five rows — never one read of twelve.
		expect(pageSizes).toEqual([5, 5, 2]);
	});

	it('reports nextUid null on the final page even when it is exactly full', async () => {
		const t = convexTest(schema, modules);
		const { folderId } = await seedFolderWithMessages(t, 4);

		const first = await t.query(internal.mail.imap.fetch.listFolderUidsPage, {
			folderId,
			limit: 4,
		});
		expect(first.uids).toEqual([1, 2, 3, 4]);
		// A full page cannot know it was the last one, so it hands back a resume
		// point; the follow-up read is the one that terminates the walk.
		expect(first.nextUid).toBe(5);
		const second = await t.query(internal.mail.imap.fetch.listFolderUidsPage, {
			folderId,
			limit: 4,
			afterUid: first.nextUid ?? 0,
		});
		expect(second.uids).toEqual([]);
		expect(second.nextUid).toBeNull();
	});
});

describe('fetchEnvelopes is bounded by the requested UID window', () => {
	it('returns only the window, ascending, and pages within it', async () => {
		const t = convexTest(schema, modules);
		const { folderId } = await seedFolderWithMessages(t, 12);

		const first = await t.query(internal.mail.imap.fetch.fetchEnvelopes, {
			folderId,
			uidLow: 4,
			uidHigh: 9,
			limit: 4,
		});
		expect(first.rows.map((r) => r.uid)).toEqual([4, 5, 6, 7]);
		expect(first.nextUid).toBe(8);

		const second = await t.query(internal.mail.imap.fetch.fetchEnvelopes, {
			folderId,
			uidLow: first.nextUid ?? 0,
			uidHigh: 9,
			limit: 4,
		});
		expect(second.rows.map((r) => r.uid)).toEqual([8, 9]);
		expect(second.nextUid).toBeNull();
	});
});

describe('CHANGEDSINCE reads the modseq index, not the folder', () => {
	it('returns only the rows above the watermark, in one small page', async () => {
		const t = convexTest(schema, modules);
		// 40 messages, of which exactly three ever changed: the changed rows sit
		// at the END of the UID order, so a UID-window read with the same page
		// size would return forty rows and post-filter down to none.
		const { folderId } = await seedFolderWithMessages(t, 40, (uid) => (uid >= 38 ? 9 : 1));

		const result = await t.query(internal.mail.imap.fetch.fetchChangedEnvelopes, {
			folderId,
			modseqSince: 5,
			paginationOpts: { numItems: 10, cursor: null },
		});

		expect(result.page.map((r) => r.uid).sort((a, b) => a - b)).toEqual([38, 39, 40]);
		expect(result.page.every((r) => r.modseq > 5)).toBe(true);
		expect(result.isDone).toBe(true);
	});

	it('pages a change set larger than one page without dropping or repeating rows', async () => {
		const t = convexTest(schema, modules);
		const { folderId } = await seedFolderWithMessages(t, 12, (uid) => 10 + uid);

		const seen: number[] = [];
		let cursor: string | null = null;
		for (let guard = 0; guard < 10; guard += 1) {
			const page = await t.query(internal.mail.imap.fetch.fetchChangedEnvelopes, {
				folderId,
				modseqSince: 14,
				paginationOpts: { numItems: 3, cursor },
			});
			seen.push(...page.page.map((r) => r.uid));
			if (page.isDone) break;
			cursor = page.continueCursor;
		}

		// modseq is 10 + uid, so "changed since 14" is UIDs 5..12.
		expect(seen.sort((a, b) => a - b)).toEqual([5, 6, 7, 8, 9, 10, 11, 12]);
	});
});

describe('resolveMessageIdsByUid pages its window', () => {
	it('resolves a 1:* style window in bounded pages', async () => {
		const t = convexTest(schema, modules);
		const { folderId } = await seedFolderWithMessages(t, 7);

		const ids: string[] = [];
		let low = 1;
		for (let guard = 0; guard < 10; guard += 1) {
			const page = await t.query(internal.mail.imap.fetch.resolveMessageIdsByUid, {
				folderId,
				uidLow: low,
				uidHigh: Number.MAX_SAFE_INTEGER,
				limit: 3,
			});
			expect(page.rows.length).toBeLessThanOrEqual(3);
			ids.push(...page.rows.map((r) => r._id));
			if (page.nextUid === null) break;
			low = page.nextUid;
		}

		expect(ids).toHaveLength(7);
		expect(new Set(ids).size).toBe(7);
	});
});
