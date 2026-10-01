/**
 * Deletions made on the provider while the worker was stopped (#1071). The
 * folder views live in memory, so a new process has seen nothing leave a
 * folder; the sighting each local message carries (folder, UIDVALIDITY, UID)
 * is what still tells "the provider had it and it is gone" from "the provider
 * never had it":
 *   - mail expunged during the downtime is reported gone by the first pass of
 *     the new process, from Trash as well as from an emptied folder;
 *   - mail never seen on the provider, and Sent, are still never called gone;
 *   - a UIDVALIDITY change between runs voids the sightings;
 *   - mail that arrives after a folder's census is not mistaken for gone;
 *   - a merge forgets the sightings of mail it finds nowhere instead of
 *     deleting it later;
 *   - a settled mailbox writes no sightings.
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
const ROLES: Record<string, LocalMessageRow['role']> = {
	INBOX: 'inbox',
	Archive: 'archive',
	Sent: 'sent',
	Trash: 'trash',
	'[Gmail]/Trash': 'trash',
	[ALL_MAIL]: 'archive',
};

/**
 * One mailbox, mirrored locally (each provider message has a row in the first
 * folder holding it), whose rows change the way `applyRemoteObservations`
 * changes them. `worker()` is a fresh process: empty views, nothing pending.
 */
function account(
	boxes: Record<string, string[]>,
	opts: { allMail?: string; onList?: () => void } = {}
) {
	const imap = new FakeImap(boxes);
	const tracked = Object.keys(boxes).filter((name) => name !== opts.allMail);
	const local = new Map<string, LocalMessageRow>();
	for (const [remoteName, ids] of Object.entries(boxes)) {
		for (const id of ids) {
			if (local.has(id)) continue;
			local.set(id, {
				messageId: id,
				remoteName,
				role: ROLES[remoteName] ?? null,
				flags: NO_FLAGS,
			});
		}
	}
	const state = { isAligned: true };
	const applied: RemoteObservation[] = [];
	const apply = async (observations: RemoteObservation[]) => {
		for (const o of observations) {
			applied.push(o);
			const row = local.get(o.messageId);
			if (!row) continue;
			if (o.isGone && state.isAligned) {
				if (row.role === 'trash') local.delete(o.messageId);
				else {
					row.remoteName = 'Trash';
					row.role = 'trash';
					row.sighting = null;
				}
				continue;
			}
			if (o.remoteFolders) {
				row.remoteName = o.remoteFolders[0]!;
				row.role = ROLES[row.remoteName] ?? null;
			}
			const here = o.sightings?.find((s) => s.remoteName === row.remoteName);
			if (here) row.sighting = here;
			if (o.forgetSightings) row.sighting = null;
		}
	};
	const worker = (): ReconcileDeps => ({
		client: imap,
		tracked,
		allMail: opts.allMail ?? null,
		views: new Map(),
		allMailCursor: { uidValidity: null, highestModseq: null },
		isAligned: state.isAligned,
		forceFull: false,
		pending: noPendingChanges(),
		listLocal: async () => {
			opts.onList?.();
			return { page: [...local.values()].map((r) => ({ ...r })), isDone: true, continueCursor: '' };
		},
		lookupLocal: async (ids) => ids.flatMap((id) => (local.has(id) ? [{ ...local.get(id)! }] : [])),
		apply,
		markAligned: async () => void (state.isAligned = true),
		isStopped: () => false,
	});
	let deps = worker();
	return {
		imap,
		local,
		state,
		get deps() {
			return deps;
		},
		/** Stop the worker and start a new one. */
		restart() {
			deps = worker();
		},
		/** One pass; what it applied. */
		async pass() {
			applied.length = 0;
			deps.isAligned = state.isAligned;
			await reconcile(deps);
			return [...applied];
		},
		/** Record the sighting ingest records when it lands a message. */
		ingested(id: string, remoteName: string) {
			const uid = imap.uidOf(remoteName, id)!;
			local.get(id)!.sighting = { remoteName, uidValidity: 1, uid };
		},
	};
}

const gone = (applied: RemoteObservation[]) =>
	applied.filter((o) => o.isGone).map((o) => o.messageId);

describe('provider deletions made while the worker was stopped (#1071)', () => {
	it('reports mail expunged during the downtime gone on the first pass after a restart', async () => {
		const acc = account({ INBOX: ['a@x', 'b@x'], Archive: [], Trash: ['t1@x', 't2@x'] });
		await acc.pass();

		acc.restart();
		acc.imap.remove('INBOX', 'a@x');
		// Trash emptied: the folder holds nothing at all now.
		acc.imap.remove('Trash', 't1@x');
		acc.imap.remove('Trash', 't2@x');
		const applied = await acc.pass();

		expect(gone(applied).sort()).toEqual(['a@x', 't1@x', 't2@x']);
		expect(acc.local.get('a@x')?.remoteName).toBe('Trash');
		expect(acc.local.has('t1@x')).toBe(false);
		expect(acc.local.get('b@x')?.remoteName).toBe('INBOX');
		// What it moved to Trash stays there: it is not reported gone a second time.
		acc.restart();
		expect(gone(await acc.pass())).toEqual([]);
		expect(acc.local.get('a@x')?.remoteName).toBe('Trash');
	});

	it('covers mail sighted at ingest that no reconcile has looked at yet', async () => {
		const acc = account({ INBOX: ['a@x'], Trash: [] });
		acc.ingested('a@x', 'INBOX');
		acc.imap.remove('INBOX', 'a@x');

		expect(gone(await acc.pass())).toEqual(['a@x']);
	});

	it('still mirrors a move made during the downtime as a move', async () => {
		const acc = account({ INBOX: ['a@x'], Archive: [], Trash: [] });
		await acc.pass();

		acc.restart();
		acc.imap.move('INBOX', 'Archive', 'a@x');
		const applied = await acc.pass();

		expect(gone(applied)).toEqual([]);
		expect(acc.local.get('a@x')?.remoteName).toBe('Archive');
	});

	it('never calls mail gone that the provider was not seen holding, nor Sent mail', async () => {
		const acc = account({ INBOX: [], Sent: ['s@x'], Trash: [] });
		acc.local.set('owlat-only@x', {
			messageId: 'owlat-only@x',
			remoteName: 'INBOX',
			role: 'inbox',
			flags: NO_FLAGS,
		});
		acc.ingested('s@x', 'Sent');
		await acc.pass();

		acc.restart();
		acc.imap.remove('Sent', 's@x');

		expect(gone(await acc.pass())).toEqual([]);
		expect(acc.local.get('owlat-only@x')?.remoteName).toBe('INBOX');
	});

	it('throws the sightings away when UIDVALIDITY changed between runs', async () => {
		const acc = account({ INBOX: ['a@x', 'b@x'], Trash: [] });
		await acc.pass();

		acc.restart();
		acc.imap.boxes.get('INBOX')!.uidValidity = 2n;
		acc.imap.remove('INBOX', 'a@x');
		const applied = await acc.pass();

		expect(gone(applied)).toEqual([]);
		expect(acc.local.get('a@x')?.remoteName).toBe('INBOX');
		// What is still there is sighted again under the new UIDVALIDITY.
		expect(acc.local.get('b@x')?.sighting?.uidValidity).toBe(2);
	});

	it('does not take mail that arrived after the census for gone', async () => {
		let arrived = false;
		const acc = account(
			{ INBOX: ['a@x'], Trash: [] },
			{
				// Ingest lands a new message after the views were refreshed, before
				// the pass reads the local rows.
				onList: () => {
					if (arrived) return;
					arrived = true;
					acc.imap.add('INBOX', 'new@x');
					acc.local.set('new@x', {
						messageId: 'new@x',
						remoteName: 'INBOX',
						role: 'inbox',
						flags: NO_FLAGS,
					});
					acc.ingested('new@x', 'INBOX');
				},
			}
		);

		expect(gone(await acc.pass())).toEqual([]);
		expect(acc.local.get('new@x')?.remoteName).toBe('INBOX');
	});

	it('tells Gmail archiving from deletion after a restart', async () => {
		const acc = account(
			{ INBOX: ['g1@x', 'g2@x'], '[Gmail]/Trash': [], [ALL_MAIL]: ['g1@x', 'g2@x'] },
			{ allMail: ALL_MAIL }
		);
		await acc.pass();

		acc.restart();
		acc.imap.remove('INBOX', 'g1@x');
		acc.imap.remove('INBOX', 'g2@x');
		acc.imap.remove(ALL_MAIL, 'g2@x');
		const applied = await acc.pass();

		expect(gone(applied)).toEqual(['g2@x']);
		expect(applied).toContainEqual({ messageId: 'g1@x', remoteFolders: [ALL_MAIL] });
	});

	it('forgets the sightings of mail a merge finds nowhere, so alignment deletes nothing', async () => {
		const acc = account({ INBOX: ['a@x', 'b@x'], Trash: [] });
		await acc.pass();

		// Full sync switched off and on again: the next pass merges.
		acc.state.isAligned = false;
		acc.restart();
		acc.imap.remove('INBOX', 'a@x');
		const merge = await acc.pass();

		expect(merge).toContainEqual({ messageId: 'a@x', forgetSightings: true });
		expect(acc.state.isAligned).toBe(true);
		expect(acc.local.get('a@x')?.sighting).toBeNull();
		expect(acc.local.get('b@x')?.sighting).toBeTruthy();

		acc.restart();
		expect(gone(await acc.pass())).toEqual([]);
		expect(acc.local.get('a@x')?.remoteName).toBe('INBOX');
	});

	it('writes sightings once and then only when they change', async () => {
		const acc = account({ INBOX: ['a@x', 'b@x'], Archive: [], Trash: ['t@x'] });
		const first = await acc.pass();
		expect(
			first
				.filter((o) => o.sightings)
				.map((o) => o.messageId)
				.sort()
		).toEqual(['a@x', 'b@x', 't@x']);

		acc.deps.forceFull = true;
		expect(await acc.pass()).toEqual([]);
		acc.restart();
		expect(await acc.pass()).toEqual([]);

		acc.imap.move('INBOX', 'Archive', 'a@x');
		await acc.pass(); // pulls the move
		acc.deps.forceFull = true;
		const resighted = await acc.pass();
		expect(resighted).toEqual([
			{
				messageId: 'a@x',
				sightings: [
					{ remoteName: 'Archive', uidValidity: 1, uid: acc.imap.uidOf('Archive', 'a@x') },
				],
			},
		]);
	});
});

/**
 * A view only vouches for absence when it read everything its folder holds.
 * A refused SEARCH or a FETCH that leaves rows out is missing evidence, never
 * evidence of a deletion: the worst outcome is a deletion mirrored a pass later.
 */
describe('an incomplete look at a folder is never taken for a deletion', () => {
	const refuseCensus = (only?: string) => (path: string, q: Record<string, unknown>) =>
		q['all'] === true && (only === undefined || path === only);

	it('reports nothing gone after a restart when the census SEARCH is refused', async () => {
		const acc = account({ INBOX: [], Trash: ['t@x'] });
		acc.ingested('t@x', 'Trash');
		acc.imap.refuseSearch = refuseCensus();

		expect(gone(await acc.pass())).toEqual([]);
		expect(acc.local.has('t@x')).toBe(true);

		acc.imap.refuseSearch = null;
		expect(gone(await acc.pass())).toEqual([]);
		expect(acc.local.has('t@x')).toBe(true);
	});

	it('still mirrors a downtime deletion once the refused census succeeds', async () => {
		const acc = account({ INBOX: ['a@x'], Trash: ['t@x'] });
		await acc.pass();

		acc.restart();
		acc.imap.remove('Trash', 't@x');
		acc.imap.refuseSearch = refuseCensus('Trash');
		expect(gone(await acc.pass())).toEqual([]);
		expect(acc.local.has('t@x')).toBe(true);

		acc.imap.refuseSearch = null;
		expect(gone(await acc.pass())).toEqual(['t@x']);
		expect(acc.local.get('a@x')?.remoteName).toBe('INBOX');
	});

	it('reports nothing gone after a restart when SEARCH lists the message but FETCH omits it', async () => {
		const acc = account({ INBOX: [], Trash: ['t@x'] });
		acc.ingested('t@x', 'Trash');
		acc.imap.unreadable.add(acc.imap.uidOf('Trash', 't@x')!);

		expect(gone(await acc.pass())).toEqual([]);
		expect(acc.local.has('t@x')).toBe(true);

		acc.imap.unreadable.clear();
		expect(gone(await acc.pass())).toEqual([]);
		expect(acc.local.has('t@x')).toBe(true);
	});

	it('does not take an unread arrival below a read one for gone', async () => {
		const acc = account({ INBOX: ['a@x'], Trash: [] });
		await acc.pass();
		for (const id of ['n1@x', 'n2@x']) {
			acc.imap.add('INBOX', id);
			acc.local.set(id, { messageId: id, remoteName: 'INBOX', role: 'inbox', flags: NO_FLAGS });
			acc.ingested(id, 'INBOX');
		}
		acc.imap.unreadable.add(acc.imap.uidOf('INBOX', 'n1@x')!);

		acc.deps.forceFull = true;
		expect(gone(await acc.pass())).toEqual([]);
		expect(acc.local.get('n1@x')?.remoteName).toBe('INBOX');
	});

	it('holds back a deletion while the folder it may have moved to cannot be read', async () => {
		const acc = account({ INBOX: ['a@x'], Archive: [], Trash: [] });
		await acc.pass();

		acc.imap.move('INBOX', 'Archive', 'a@x');
		acc.imap.unreadable.add(acc.imap.uidOf('Archive', 'a@x')!);
		expect(gone(await acc.pass())).toEqual([]);
		expect(acc.local.get('a@x')?.remoteName).toBe('INBOX');

		acc.imap.unreadable.clear();
		expect(await acc.pass()).toContainEqual(
			expect.objectContaining({ messageId: 'a@x', remoteFolders: ['Archive'] })
		);
		expect(acc.local.get('a@x')?.remoteName).toBe('Archive');
	});

	/**
	 * A view an earlier census completed, whose census this pass fails: it
	 * dates from before mail moved into it, so it cannot vouch for an absence.
	 */
	const movedOutOfTrash = async () => {
		const acc = account({ INBOX: [], Archive: [], Trash: ['t@x'] });
		await acc.pass();
		acc.imap.move('Trash', 'Archive', 't@x');
		acc.imap.refuseSearch = refuseCensus('Archive');
		return acc;
	};

	it('does not purge Trash mail moved to a folder whose census fails after a reconnect', async () => {
		const acc = await movedOutOfTrash();
		// What a reconnect does: every folder's next refresh takes a census.
		for (const view of acc.deps.views.values()) view.censusDue = true;

		expect(gone(await acc.pass())).toEqual([]);
		expect(acc.local.get('t@x')?.remoteName).toBe('Trash');
		expect(acc.deps.views.get('Archive')?.isComplete).toBe(false);

		acc.imap.refuseSearch = null;
		const applied = await acc.pass();
		expect(gone(applied)).toEqual([]);
		expect(acc.local.get('t@x')?.remoteName).toBe('Archive');
	});

	it('does not purge Trash mail moved to a folder whose census fails on a full reconcile', async () => {
		const acc = await movedOutOfTrash();
		acc.deps.forceFull = true;

		expect(gone(await acc.pass())).toEqual([]);
		expect(acc.local.get('t@x')?.remoteName).toBe('Trash');

		// Still incomplete on the next, ordinary pass while the census keeps failing.
		acc.deps.forceFull = false;
		expect(gone(await acc.pass())).toEqual([]);
		expect(acc.local.get('t@x')?.remoteName).toBe('Trash');

		acc.imap.refuseSearch = null;
		expect(gone(await acc.pass())).toEqual([]);
		expect(acc.local.get('t@x')?.remoteName).toBe('Archive');
	});

	it('mirrors a real deletion once the failed census of another folder succeeds', async () => {
		const acc = account({ INBOX: ['a@x'], Archive: [], Trash: ['t@x'] });
		await acc.pass();
		acc.imap.remove('Trash', 't@x');
		acc.imap.refuseSearch = refuseCensus('Archive');
		for (const view of acc.deps.views.values()) view.censusDue = true;

		expect(gone(await acc.pass())).toEqual([]);
		expect(acc.local.has('t@x')).toBe(true);

		acc.imap.refuseSearch = null;
		expect(gone(await acc.pass())).toEqual(['t@x']);
		expect(acc.local.has('t@x')).toBe(false);
		expect(acc.local.get('a@x')?.remoteName).toBe('INBOX');
	});

	it('takes a census when the search for new mail fails, whatever the message count says', async () => {
		const acc = account({ INBOX: [], Archive: ['old@x'], Trash: ['t@x'] });
		await acc.pass();
		// Archive's count is unchanged: one message left it, one arrived.
		acc.imap.move('Trash', 'Archive', 't@x');
		acc.imap.remove('Archive', 'old@x');
		acc.imap.refuseSearch = (path, q) => path === 'Archive' && typeof q['uid'] === 'string';

		const applied = await acc.pass();
		expect(gone(applied)).toEqual(['old@x']);
		expect(acc.local.get('t@x')?.remoteName).toBe('Archive');
	});

	it.each([
		[
			'refuses the SEARCH',
			(acc: ReturnType<typeof account>) => {
				acc.imap.refuseSearch = (path) => path === ALL_MAIL;
			},
		],
		[
			'omits the FETCH row',
			(acc: ReturnType<typeof account>) => {
				acc.imap.unreadable.add(acc.imap.uidOf(ALL_MAIL, 'g@x')!);
			},
		],
	])('does not call archived Gmail mail gone when All Mail %s', async (_, fault) => {
		const acc = account(
			{ INBOX: ['g@x'], '[Gmail]/Trash': [], [ALL_MAIL]: ['g@x'] },
			{ allMail: ALL_MAIL }
		);
		await acc.pass();

		acc.imap.remove('INBOX', 'g@x');
		fault(acc);
		expect(gone(await acc.pass())).toEqual([]);
		expect(acc.local.get('g@x')?.remoteName).toBe('INBOX');

		acc.imap.refuseSearch = null;
		acc.imap.unreadable.clear();
		expect(await acc.pass()).toContainEqual({ messageId: 'g@x', remoteFolders: [ALL_MAIL] });
	});
});
