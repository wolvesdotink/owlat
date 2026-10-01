/**
 * Remote → local change sync (remoteState.ts), against an in-memory IMAP server.
 * What matters, in order:
 *   - a change on the provider is noticed: a message leaving or entering a
 *     folder, and a flag flipped (by CHANGEDSINCE, or by re-reading the newest
 *     messages on a server without CONDSTORE);
 *   - a move is reported with where the message is now, and a deletion only
 *     when the message left a folder AND is nowhere else — Gmail's All Mail is
 *     searched before anything is called deleted;
 *   - mail Owlat wrote itself (Sent, Drafts) is never called deleted;
 *   - a full reconcile compares every local message and marks the account
 *     aligned once it completes.
 */

import { describe, expect, it } from 'vitest';
import {
	decide,
	FolderView,
	parseMessageIdHeader,
	reconcile,
	refreshFolder,
	type LocalMessageRow,
	type RemoteObservation,
	type ReconcileDeps,
} from '../remoteState.js';
import { FakeImap } from './fakeImap.js';
import { isVirtualView, mirroredFolderPath } from '../folders.js';

const NO_FLAGS = { seen: false, flagged: false, answered: false };

function row(messageId: string, remoteName: string | null, extra: Partial<LocalMessageRow> = {}) {
	return {
		messageId,
		remoteName,
		role: extra.role ?? (remoteName === 'INBOX' ? 'inbox' : null),
		flags: extra.flags ?? NO_FLAGS,
	} satisfies LocalMessageRow;
}

describe('parseMessageIdHeader', () => {
	it('reads a folded header and strips the brackets', () => {
		expect(parseMessageIdHeader(Buffer.from('Message-ID:\r\n <a@x.example>\r\n\r\n'))).toBe(
			'a@x.example'
		);
		expect(parseMessageIdHeader(Buffer.from('\r\n'))).toBeNull();
	});
});

describe('refreshFolder', () => {
	it('reports what left and what arrived since the last refresh', async () => {
		const imap = new FakeImap({ INBOX: ['a@x', 'b@x'] });
		const view = new FolderView();
		const first = await refreshFolder(imap, 'INBOX', view);
		expect(first.rebuilt).toBe(true);
		expect(first.changed.size).toBe(0);

		imap.remove('INBOX', 'a@x');
		imap.add('INBOX', 'c@x');
		const next = await refreshFolder(imap, 'INBOX', view);

		expect(next.rebuilt).toBe(false);
		expect([...next.vanished]).toEqual(['a@x']);
		expect([...next.changed].sort()).toEqual(['a@x', 'c@x']);
	});

	it('picks up a flag change by CHANGEDSINCE', async () => {
		const imap = new FakeImap({ INBOX: ['a@x', 'b@x'] });
		const view = new FolderView();
		await refreshFolder(imap, 'INBOX', view);

		imap.setFlag('INBOX', 'b@x', '\\Seen', true);
		const next = await refreshFolder(imap, 'INBOX', view);

		expect([...next.changed]).toEqual(['b@x']);
	});

	it('re-reads the newest messages on a server without CONDSTORE', async () => {
		const imap = new FakeImap({ INBOX: ['a@x'] }, false);
		const view = new FolderView();
		await refreshFolder(imap, 'INBOX', view);

		imap.setFlag('INBOX', 'a@x', '\\Flagged', true);
		const next = await refreshFolder(imap, 'INBOX', view);

		expect([...next.changed]).toEqual(['a@x']);
	});

	it('starts over after a UIDVALIDITY change', async () => {
		const imap = new FakeImap({ INBOX: ['a@x'] });
		const view = new FolderView();
		await refreshFolder(imap, 'INBOX', view);
		imap.boxes.get('INBOX')!.uidValidity = 2n;

		expect((await refreshFolder(imap, 'INBOX', view)).rebuilt).toBe(true);
	});
});

describe('decide', () => {
	const input = (index: Record<string, string[]>, untracked: string[] = []) => ({
		index: new Map(
			Object.entries(index).map(([id, names]) => [
				id,
				names.map((remoteName) => ({ remoteName, flags: NO_FLAGS })),
			])
		),
		order: ['INBOX', 'Work', 'Archive', 'Sent', 'Trash'],
		untracked: new Set(untracked),
		untrackedFlags: new Map(),
	});

	it('reports a message found somewhere other than its local folder', () => {
		const { observations } = decide([row('a@x', 'INBOX')], input({ 'a@x': ['Work'] }));
		expect(observations).toEqual([{ messageId: 'a@x', remoteFolders: ['Work'] }]);
	});

	it('leaves a message alone while its local folder still holds it', () => {
		const { observations, unplaced } = decide(
			[row('a@x', 'INBOX')],
			input({ 'a@x': ['Work', 'INBOX'] })
		);
		expect(observations).toEqual([]);
		expect(unplaced).toEqual([]);
	});

	it('never questions Sent or Drafts, or a message in an untracked All Mail', () => {
		const { unplaced } = decide(
			[
				row('s@x', 'Sent', { role: 'sent' }),
				row('g@x', '[Gmail]/All Mail', { role: 'archive' }),
				row('i@x', 'INBOX'),
			],
			input({}, ['[Gmail]/All Mail'])
		);
		expect(unplaced.map((r) => r.messageId)).toEqual(['i@x']);
	});

	it('reports provider flags that differ', () => {
		const rows = [row('a@x', 'INBOX')];
		const withSeen = input({ 'a@x': ['INBOX'] });
		withSeen.index.get('a@x')![0]!.flags = { seen: true, flagged: false, answered: false };
		expect(decide(rows, withSeen).observations).toEqual([
			{ messageId: 'a@x', flags: { seen: true, flagged: false, answered: false } },
		]);
	});
});

describe('reconcile', () => {
	function harness(imap: FakeImap, local: LocalMessageRow[], opts: Partial<ReconcileDeps> = {}) {
		const applied: RemoteObservation[] = [];
		const lookups: string[][] = [];
		let aligned = 0;
		const deps: ReconcileDeps = {
			client: imap,
			tracked: ['INBOX', 'Archive', 'Trash', 'Sent'],
			allMail: null,
			views: new Map(),
			allMailCursor: { uidValidity: null, highestModseq: null },
			isAligned: true,
			forceFull: false,
			listLocal: async () => ({ page: local, isDone: true, continueCursor: '' }),
			lookupLocal: async (ids) => {
				lookups.push(ids);
				return local.filter((r) => ids.includes(r.messageId));
			},
			apply: async (obs) => void applied.push(...obs),
			markAligned: async () => void (aligned += 1),
			isStopped: () => false,
			...opts,
		};
		return {
			deps,
			applied,
			lookups,
			get aligned() {
				return aligned;
			},
		};
	}

	it('mirrors a move made on the provider', async () => {
		const imap = new FakeImap({ INBOX: ['a@x', 'b@x'], Archive: [], Trash: [], Sent: [] });
		const h = harness(imap, [row('a@x', 'INBOX'), row('b@x', 'INBOX')]);
		await reconcile(h.deps); // first pass builds the views

		imap.move('INBOX', 'Archive', 'a@x');
		h.applied.length = 0;
		const { full } = await reconcile(h.deps);

		expect(full).toBe(false);
		expect(h.lookups.at(-1)).toEqual(['a@x']);
		expect(h.applied).toEqual([{ messageId: 'a@x', remoteFolders: ['Archive'] }]);
	});

	it('reports a message deleted on the provider as gone', async () => {
		const imap = new FakeImap({ INBOX: ['a@x'], Archive: [], Trash: ['t@x'], Sent: [] });
		const h = harness(imap, [row('a@x', 'INBOX'), row('t@x', 'Trash', { role: 'trash' })]);
		await reconcile(h.deps);

		imap.remove('Trash', 't@x');
		h.applied.length = 0;
		await reconcile(h.deps);

		expect(h.applied).toEqual([{ messageId: 't@x', isGone: true }]);
	});

	it('calls Gmail archiving a move to All Mail, not a deletion', async () => {
		const gmail = new FakeImap({
			INBOX: ['g@x'],
			'[Gmail]/All Mail': ['g@x'],
			'[Gmail]/Trash': [],
		});
		const h = harness(gmail, [row('g@x', 'INBOX')], {
			tracked: ['INBOX', '[Gmail]/Trash'],
			allMail: '[Gmail]/All Mail',
		});
		await reconcile(h.deps);

		gmail.remove('INBOX', 'g@x');
		h.applied.length = 0;
		await reconcile(h.deps);

		expect(h.applied).toEqual([{ messageId: 'g@x', remoteFolders: ['[Gmail]/All Mail'] }]);
	});

	it('reads flag changes of archived Gmail mail from All Mail', async () => {
		const gmail = new FakeImap({ INBOX: [], '[Gmail]/All Mail': ['g@x'] });
		const archived = row('g@x', '[Gmail]/All Mail', { role: 'archive' });
		const h = harness(gmail, [archived], { tracked: ['INBOX'], allMail: '[Gmail]/All Mail' });
		await reconcile(h.deps);

		gmail.setFlag('[Gmail]/All Mail', 'g@x', '\\Flagged', true);
		h.applied.length = 0;
		await reconcile(h.deps);

		expect(h.applied).toEqual([
			{ messageId: 'g@x', flags: { seen: false, flagged: true, answered: false } },
		]);
	});

	it('follows mail out of a folder the provider renamed', async () => {
		const imap = new FakeImap({ INBOX: [], Old: ['a@x'], Archive: [], Trash: [], Sent: [] });
		const h = harness(imap, [row('a@x', 'Old')], {
			tracked: ['INBOX', 'Old', 'Archive', 'Trash', 'Sent'],
		});
		await reconcile(h.deps);

		imap.boxes.set('New', imap.boxes.get('Old')!);
		imap.boxes.delete('Old');
		h.deps.tracked = ['INBOX', 'New', 'Archive', 'Trash', 'Sent'];
		h.applied.length = 0;
		await reconcile(h.deps);

		expect(h.applied).toEqual([{ messageId: 'a@x', remoteFolders: ['New'] }]);
	});

	it('calls mail gone when the provider deleted its folder with it', async () => {
		const imap = new FakeImap({ INBOX: [], Old: ['a@x'], Archive: [], Trash: [], Sent: [] });
		const h = harness(imap, [row('a@x', 'Old')], {
			tracked: ['INBOX', 'Old', 'Archive', 'Trash', 'Sent'],
		});
		await reconcile(h.deps);

		imap.boxes.delete('Old');
		h.deps.tracked = ['INBOX', 'Archive', 'Trash', 'Sent'];
		h.applied.length = 0;
		const result = await reconcile(h.deps);

		expect(result.completed).toBe(true);
		expect(h.applied).toEqual([{ messageId: 'a@x', isGone: true }]);
	});

	it('does not call mail Owlat never saw on the provider deleted, even on a full pass', async () => {
		const imap = new FakeImap({ INBOX: [], Archive: [], Trash: [], Sent: [] });
		const h = harness(imap, [row('local-only@x', 'INBOX')], { forceFull: true });

		await reconcile(h.deps);

		expect(h.applied).toEqual([]);
	});

	it('compares everything and marks the account aligned when it was not', async () => {
		const imap = new FakeImap({ INBOX: [], Archive: ['a@x'], Trash: [], Sent: [] });
		const h = harness(imap, [row('a@x', 'INBOX')], { isAligned: false });

		const { full } = await reconcile(h.deps);

		expect(full).toBe(true);
		expect(h.applied).toEqual([{ messageId: 'a@x', remoteFolders: ['Archive'] }]);
		expect(h.aligned).toBe(1);
	});
});

describe('mirroredFolderPath', () => {
	it('mirrors a user folder under its own name, without the namespace prefix', () => {
		expect(
			mirroredFolderPath(
				{ path: 'INBOX.Projects.Owlat', delimiter: '.', flags: new Set() },
				'INBOX.'
			)
		).toEqual(['Projects', 'Owlat']);
		expect(
			mirroredFolderPath({ path: 'INBOX/Receipts', delimiter: '/', flags: new Set() }, '')
		).toEqual(['Receipts']);
	});

	it('skips INBOX, unselectable folders and Gmail views', () => {
		expect(mirroredFolderPath({ path: 'INBOX', delimiter: '/' }, '')).toBeNull();
		expect(
			mirroredFolderPath({ path: '[Gmail]', delimiter: '/', flags: new Set(['\\Noselect']) }, '')
		).toBeNull();
		expect(
			mirroredFolderPath({ path: '[Gmail]/Starred', delimiter: '/', specialUse: '\\Flagged' }, '')
		).toBeNull();
	});

	// imapflow fills `specialUse` only from the RFC 6154 set, which has no
	// \Important: Gmail's Important view reaches us as a bare LIST attribute.
	it('skips a view that carries its attribute only in the LIST flags (Gmail Important)', () => {
		const important = {
			path: '[Gmail]/Wichtig',
			delimiter: '/',
			flags: new Set(['\\HasNoChildren', '\\Important']),
		};
		const archive = { path: 'Erledigt', delimiter: '/', flags: new Set(['\\HasNoChildren']) };
		expect(isVirtualView(important)).toBe(true);
		expect(mirroredFolderPath(important, '')).toBeNull();
		expect(isVirtualView(archive)).toBe(false);
	});
});
