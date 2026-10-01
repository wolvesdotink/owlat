/**
 * Bulk removals at the provider beyond the per-pass All Mail look-up budget
 * (#1008). A pass checks at most MAX_CONFIRMS_PER_CYCLE vanished messages in
 * All Mail; the views have already dropped the rest, so they must be carried
 * to the next pass rather than forgotten:
 *   - without an All Mail folder there is nothing to look up, and every
 *     vanished message is settled in the pass that noticed it;
 *   - with one, Gmail deletions and archiving converge over passes, each
 *     pass staying within the budget;
 *   - a pass cut short, or an apply that fails, loses nothing;
 *   - mail never seen on the provider is still not called deleted.
 */

import { describe, expect, it } from 'vitest';
import {
	noPendingChanges,
	reconcile,
	type LocalMessageRow,
	type ReconcileDeps,
	type RemoteObservation,
} from '../remoteState.js';
import { FakeImap } from './fakeImap.js';

const NO_FLAGS = { seen: false, flagged: false, answered: false };
const ALL_MAIL = '[Gmail]/All Mail';
const BUDGET = 500;

/**
 * An account whose INBOX holds `size` messages, mirrored locally. `gmail`
 * adds an All Mail that holds every message and is searched before a
 * vanished message is judged.
 */
function account(size: number, { gmail }: { gmail: boolean }) {
	const ids = Array.from({ length: size }, (_, i) => `msg-${i}@x`);
	const boxes: Record<string, string[]> = { INBOX: ids, Trash: [] };
	if (gmail) boxes[ALL_MAIL] = [...ids];
	const imap = new FakeImap(boxes);
	const local = new Map<string, LocalMessageRow>(
		ids.map((id) => [id, { messageId: id, remoteName: 'INBOX', role: 'inbox', flags: NO_FLAGS }])
	);
	const applied: RemoteObservation[] = [];
	/** Message-IDs searched for in All Mail, per pass. */
	let confirmed: string[] = [];
	let selected = '';
	const lock = imap.getMailboxLock.bind(imap);
	imap.getMailboxLock = async (path: string) => {
		selected = path;
		return lock(path);
	};
	const search = imap.search.bind(imap);
	imap.search = async (query: object) => {
		if (selected === ALL_MAIL) {
			const q = query as { or?: Array<{ header: Record<string, string> }> } & {
				header?: Record<string, string>;
			};
			for (const term of q.or ?? (q.header ? [q] : [])) {
				confirmed.push(term.header!['message-id']!);
			}
		}
		return search(query);
	};
	let clock = 1_000_000;
	const deps: ReconcileDeps = {
		client: imap,
		tracked: ['INBOX', 'Trash'],
		allMail: gmail ? ALL_MAIL : null,
		views: new Map(),
		allMailCursor: { uidValidity: null, highestModseq: null },
		isAligned: true,
		forceFull: false,
		now: () => clock,
		pending: noPendingChanges(),
		listLocal: async () => ({ page: [...local.values()], isDone: true, continueCursor: '' }),
		lookupLocal: async (lookup) => lookup.flatMap((id) => local.get(id) ?? []),
		apply: async (observations) => {
			for (const o of observations) {
				applied.push(o);
				const row = local.get(o.messageId);
				if (!row) continue;
				if (o.isGone) local.delete(o.messageId);
				if (o.remoteFolders) row.remoteName = o.remoteFolders[0]!;
			}
		},
		markAligned: async () => undefined,
		isStopped: () => false,
	};
	return {
		imap,
		deps,
		local,
		ids,
		/** One pass, with what it applied and what it looked for in All Mail. */
		async pass() {
			clock += 60_000;
			applied.length = 0;
			confirmed = [];
			const result = await reconcile(deps);
			return { ...result, applied: [...applied], confirmed: [...confirmed] };
		},
		/** Local messages still filed in INBOX. */
		inInbox() {
			return [...local.values()].filter((r) => r.remoteName === 'INBOX').map((r) => r.messageId);
		},
	};
}

describe('vanished mail beyond the All Mail look-up budget (#1008)', () => {
	for (const removed of [501, 1001]) {
		it(`settles ${removed} deletions in one pass when there is no All Mail to search`, async () => {
			const acc = account(removed + 20, { gmail: false });
			await acc.pass();
			for (const id of acc.ids.slice(0, removed)) acc.imap.remove('INBOX', id);

			const pass = await acc.pass();

			expect(pass.completed).toBe(true);
			expect(pass.applied.filter((o) => o.isGone)).toHaveLength(removed);
			expect(acc.local.size).toBe(20);
			expect(acc.deps.pending).toEqual(noPendingChanges());
		});

		it(`deletes ${removed} Gmail messages over passes, within the budget each time`, async () => {
			const acc = account(removed + 20, { gmail: true });
			await acc.pass();
			for (const id of acc.ids.slice(0, removed)) {
				acc.imap.remove('INBOX', id);
				acc.imap.remove(ALL_MAIL, id);
			}

			const passes = Math.ceil(removed / BUDGET);
			let gone = 0;
			for (let i = 0; i < passes; i++) {
				const pass = await acc.pass();
				expect(pass.completed).toBe(true);
				expect(pass.confirmed.length).toBeLessThanOrEqual(BUDGET);
				gone += pass.applied.filter((o) => o.isGone).length;
			}

			expect(gone).toBe(removed);
			expect(acc.local.size).toBe(20);
			expect(acc.deps.pending).toEqual(noPendingChanges());
			expect((await acc.pass()).applied).toEqual([]);
		});

		it(`moves ${removed} archived Gmail messages to All Mail over passes`, async () => {
			const acc = account(removed + 20, { gmail: true });
			await acc.pass();
			for (const id of acc.ids.slice(0, removed)) acc.imap.remove('INBOX', id);

			for (let i = 0; i < Math.ceil(removed / BUDGET); i++) {
				const pass = await acc.pass();
				expect(pass.confirmed.length).toBeLessThanOrEqual(BUDGET);
				expect(pass.applied.some((o) => o.isGone)).toBe(false);
			}

			expect(acc.inInbox()).toEqual(acc.ids.slice(removed));
			expect(acc.local.size).toBe(removed + 20);
			expect(acc.deps.pending).toEqual(noPendingChanges());
		});
	}

	it('keeps the deferred messages through a full reconcile that follows', async () => {
		const acc = account(1021, { gmail: true });
		await acc.pass();
		for (const id of acc.ids.slice(0, 1001)) {
			acc.imap.remove('INBOX', id);
			acc.imap.remove(ALL_MAIL, id);
		}

		await acc.pass();
		acc.deps.forceFull = true;
		await acc.pass();
		acc.deps.forceFull = false;
		await acc.pass();

		expect(acc.local.size).toBe(20);
	});

	it('carries the deferred messages past a pass cut short and an apply that fails', async () => {
		const acc = account(1021, { gmail: true });
		await acc.pass();
		const deleted = acc.ids.slice(0, 600);
		const archived = acc.ids.slice(600, 1001);
		for (const id of deleted) {
			acc.imap.remove('INBOX', id);
			acc.imap.remove(ALL_MAIL, id);
		}
		for (const id of archived) acc.imap.remove('INBOX', id);

		expect((await acc.pass()).completed).toBe(true); // the first 500 are checked

		// The connection drops during the next pass's local look-ups.
		let checks = 0;
		acc.deps.isStopped = () => ++checks > 3;
		expect((await acc.pass()).completed).toBe(false);
		acc.deps.isStopped = () => false;

		// Then the backend refuses the second batch of observations.
		const apply = acc.deps.apply;
		let calls = 0;
		acc.deps.apply = async (observations) => {
			if (++calls === 2) throw new Error('backend unavailable');
			await apply(observations);
		};
		await expect(acc.pass()).rejects.toThrow('backend unavailable');
		acc.deps.apply = apply;

		for (let i = 0; i < 3; i++) await acc.pass();

		for (const id of deleted) expect(acc.local.has(id)).toBe(false);
		expect(acc.inInbox()).toEqual(acc.ids.slice(1001));
		expect(archived.every((id) => acc.local.get(id)?.remoteName === ALL_MAIL)).toBe(true);
		expect(acc.deps.pending).toEqual(noPendingChanges());
	});

	it('does not call deferred mail never seen on the provider deleted', async () => {
		const acc = account(20, { gmail: true });
		// 600 local messages the provider never had, in no view and not in All Mail.
		for (let i = 0; i < 600; i++) {
			const id = `local-only-${i}@x`;
			acc.local.set(id, { messageId: id, remoteName: 'INBOX', role: 'inbox', flags: NO_FLAGS });
		}
		acc.deps.forceFull = true;

		for (let i = 0; i < 3; i++) {
			const pass = await acc.pass();
			expect(pass.confirmed.length).toBeLessThanOrEqual(BUDGET);
			expect(pass.applied.filter((o) => o.isGone)).toEqual([]);
		}
		expect(acc.local.size).toBe(620);
	});

	it('checks vanished mail before mail that merely sits in no folder', async () => {
		const acc = account(20, { gmail: true });
		for (let i = 0; i < 600; i++) {
			const id = `local-only-${i}@x`;
			acc.local.set(id, { messageId: id, remoteName: 'INBOX', role: 'inbox', flags: NO_FLAGS });
		}
		// Listed after them, so a pass taking candidates in page order would spend
		// its whole budget on the never-seen ones first.
		for (const id of acc.ids) {
			const row = acc.local.get(id)!;
			acc.local.delete(id);
			acc.local.set(id, row);
		}
		await acc.pass();
		acc.imap.remove('INBOX', 'msg-19@x');
		acc.imap.remove(ALL_MAIL, 'msg-19@x');
		acc.deps.forceFull = true;

		const pass = await acc.pass();

		expect(pass.applied).toContainEqual({ messageId: 'msg-19@x', isGone: true });
	});
});
