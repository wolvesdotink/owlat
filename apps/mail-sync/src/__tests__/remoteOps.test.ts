/**
 * Replaying Owlat's write-back queue on the provider (remoteOps.ts), against an
 * in-memory IMAP server. What matters, in order:
 *   - the change lands on the right message: a header search is a substring
 *     match, so only an envelope-confirmed Message-ID is acted on;
 *   - nothing is lost: Gmail's All Mail is copied out of, never moved or
 *     deleted from, and a delete only ever touches the folder it names;
 *   - a message filed before the queue existed is still found in the other
 *     synced folders;
 *   - user folders are created once, under the server's namespace.
 */

import { describe, expect, it } from 'vitest';
import {
	drainRemoteOps,
	RemoteOpReplayer,
	type RemoteFolderMap,
	type RemoteOp,
	type RemoteOpResult,
	type RemoteOpsClient,
} from '../remoteOps.js';
import type { FolderRole } from '../folders.js';

interface FakeMessage {
	uid: number;
	messageId: string;
	flags: Set<string>;
}

class FakeImap implements RemoteOpsClient {
	usable = true;
	namespace: { prefix: string; delimiter: string } = { prefix: '', delimiter: '/' };
	readonly boxes = new Map<string, FakeMessage[]>();
	readonly log: string[] = [];
	private selected: string | null = null;
	private nextUid = 1000;

	constructor(boxes: Record<string, Array<[number, string]>>) {
		for (const [path, messages] of Object.entries(boxes)) {
			this.boxes.set(
				path,
				messages.map(([uid, messageId]) => ({ uid, messageId, flags: new Set<string>() }))
			);
		}
	}

	private box(): FakeMessage[] {
		const box = this.selected === null ? undefined : this.boxes.get(this.selected);
		if (!box) throw new Error('no mailbox selected');
		return box;
	}

	private take(range: string): FakeMessage[] {
		const uids = new Set(range.split(',').map(Number));
		return this.box().filter((m) => uids.has(m.uid));
	}

	private put(path: string, messages: FakeMessage[]): void {
		const target = this.boxes.get(path);
		if (!target) throw new Error(`NO [TRYCREATE] ${path}`);
		for (const m of messages) target.push({ ...m, uid: this.nextUid++, flags: new Set(m.flags) });
	}

	async getMailboxLock(path: string) {
		if (!this.boxes.has(path)) throw new Error(`NO [NONEXISTENT] ${path}`);
		this.selected = path;
		return { release: () => void (this.selected = null) };
	}

	async search(query: { header: Record<string, string> }) {
		const needle = query.header['message-id'] ?? '';
		return this.box()
			.filter((m) => m.messageId.includes(needle))
			.map((m) => m.uid);
	}

	async *fetch(range: string) {
		for (const m of this.take(range)) yield { uid: m.uid, envelope: { messageId: m.messageId } };
	}

	async messageMove(range: string, destination: string) {
		this.log.push(`MOVE ${this.selected} ${range} -> ${destination}`);
		const moving = this.take(range);
		this.put(destination, moving);
		const box = this.box();
		for (const m of moving) box.splice(box.indexOf(m), 1);
	}

	async messageCopy(range: string, destination: string) {
		this.log.push(`COPY ${this.selected} ${range} -> ${destination}`);
		this.put(destination, this.take(range));
	}

	async messageFlagsAdd(range: string, flags: string[]) {
		this.log.push(`+FLAGS ${this.selected} ${range} ${flags.join(' ')}`);
		for (const m of this.take(range)) for (const f of flags) m.flags.add(f);
	}

	async messageFlagsRemove(range: string, flags: string[]) {
		this.log.push(`-FLAGS ${this.selected} ${range} ${flags.join(' ')}`);
		for (const m of this.take(range)) for (const f of flags) m.flags.delete(f);
	}

	async messageDelete(range: string) {
		this.log.push(`DELETE ${this.selected} ${range}`);
		const box = this.box();
		for (const m of this.take(range)) box.splice(box.indexOf(m), 1);
	}

	async mailboxCreate(segments: string[]) {
		const path = this.namespace.prefix + segments.join(this.namespace.delimiter);
		if (!this.boxes.has(path)) {
			this.log.push(`CREATE ${path}`);
			this.boxes.set(path, []);
		}
		return { path };
	}

	ids(path: string): string[] {
		return (this.boxes.get(path) ?? []).map((m) => m.messageId);
	}
}

function folderMap(byRole: Partial<Record<FolderRole, string>>, allMail: string[] = []) {
	return {
		byRole: new Map(Object.entries(byRole) as Array<[FolderRole, string]>),
		allMail: new Set(allMail),
	} satisfies RemoteFolderMap;
}

let opSeq = 0;
function op(fields: Omit<RemoteOp, 'opId' | 'attempts'>): RemoteOp {
	opSeq += 1;
	return { opId: `op${opSeq}`, attempts: 0, ...fields };
}

const STANDARD = { inbox: 'INBOX', archive: 'Archive', trash: 'Trash', sent: 'Sent' } as const;

describe('RemoteOpReplayer', () => {
	it('moves the message out of the folder the op names', async () => {
		const imap = new FakeImap({ INBOX: [[1, '<a@x>']], Archive: [], Trash: [], Sent: [] });
		const replayer = new RemoteOpReplayer(imap, folderMap(STANDARD));

		const outcome = await replayer.apply(
			op({
				kind: 'move',
				rfc822MessageId: 'a@x',
				source: { role: 'inbox' },
				target: { role: 'archive' },
			})
		);

		expect(outcome).toBe('done');
		expect(imap.ids('INBOX')).toEqual([]);
		expect(imap.ids('Archive')).toEqual(['<a@x>']);
	});

	it('acts only on a Message-ID the envelope confirms, not on a substring hit', async () => {
		const imap = new FakeImap({
			INBOX: [[1, '<xa@x>']],
			Archive: [],
			Trash: [],
			Sent: [],
		});
		const replayer = new RemoteOpReplayer(imap, folderMap(STANDARD));

		const outcome = await replayer.apply(
			op({
				kind: 'move',
				rfc822MessageId: 'a@x',
				source: { role: 'inbox' },
				target: { role: 'trash' },
			})
		);

		expect(outcome).toBe('not_found');
		expect(imap.ids('INBOX')).toEqual(['<xa@x>']);
		expect(imap.log).toEqual([]);
	});

	it('finds a message filed elsewhere in the other synced folders', async () => {
		// Archived on the provider before the queue existed; Owlat still has it in the inbox.
		const imap = new FakeImap({ INBOX: [], Archive: [[4, '<b@x>']], Trash: [], Sent: [] });
		const replayer = new RemoteOpReplayer(imap, folderMap(STANDARD));

		const outcome = await replayer.apply(
			op({
				kind: 'move',
				rfc822MessageId: 'b@x',
				source: { role: 'inbox' },
				target: { role: 'trash' },
			})
		);

		expect(outcome).toBe('done');
		expect(imap.ids('Trash')).toEqual(['<b@x>']);
	});

	it('never pulls a message out of Sent unless the op names Sent', async () => {
		const imap = new FakeImap({ INBOX: [], Archive: [], Trash: [], Sent: [[2, '<s@x>']] });
		const replayer = new RemoteOpReplayer(imap, folderMap(STANDARD));

		const outcome = await replayer.apply(
			op({
				kind: 'move',
				rfc822MessageId: 's@x',
				source: { role: 'inbox' },
				target: { role: 'archive' },
			})
		);

		expect(outcome).toBe('not_found');
		expect(imap.ids('Sent')).toEqual(['<s@x>']);
	});

	it('copies out of Gmail All Mail instead of moving, so the message keeps its other labels', async () => {
		const gmail = new FakeImap({
			INBOX: [],
			'[Gmail]/All Mail': [[9, '<g@x>']],
			'[Gmail]/Trash': [],
		});
		const replayer = new RemoteOpReplayer(
			gmail,
			folderMap({ inbox: 'INBOX', archive: '[Gmail]/All Mail', trash: '[Gmail]/Trash' }, [
				'[Gmail]/All Mail',
			])
		);

		const outcome = await replayer.apply(
			op({
				kind: 'move',
				rfc822MessageId: 'g@x',
				source: { role: 'archive' },
				target: { role: 'inbox' },
			})
		);

		expect(outcome).toBe('done');
		expect(gmail.log).toEqual(['COPY [Gmail]/All Mail 9 -> INBOX']);
		expect(gmail.ids('[Gmail]/All Mail')).toEqual(['<g@x>']);
	});

	it('archives into Gmail All Mail with a move out of the inbox', async () => {
		const gmail = new FakeImap({ INBOX: [[3, '<g@x>']], '[Gmail]/All Mail': [[9, '<g@x>']] });
		const replayer = new RemoteOpReplayer(
			gmail,
			folderMap({ inbox: 'INBOX', archive: '[Gmail]/All Mail' }, ['[Gmail]/All Mail'])
		);

		await replayer.apply(
			op({
				kind: 'move',
				rfc822MessageId: 'g@x',
				source: { role: 'inbox' },
				target: { role: 'archive' },
			})
		);

		expect(gmail.log).toEqual(['MOVE INBOX 3 -> [Gmail]/All Mail']);
	});

	it('creates a user folder once, under the server namespace, and finds it again later', async () => {
		const imap = new FakeImap({
			INBOX: [
				[1, '<a@x>'],
				[2, '<b@x>'],
			],
		});
		imap.namespace = { prefix: 'INBOX.', delimiter: '.' };
		const folders = folderMap({ inbox: 'INBOX' });
		const replayer = new RemoteOpReplayer(imap, folders);
		const target = { path: ['Projects', 'Owlat'] };

		await replayer.apply(
			op({ kind: 'move', rfc822MessageId: 'a@x', source: { role: 'inbox' }, target })
		);
		await replayer.apply(
			op({ kind: 'move', rfc822MessageId: 'b@x', source: { role: 'inbox' }, target })
		);

		expect(imap.log.filter((l) => l.startsWith('CREATE'))).toEqual(['CREATE INBOX.Projects.Owlat']);
		expect(imap.ids('INBOX.Projects.Owlat')).toEqual(['<a@x>', '<b@x>']);

		// A later connection has no memory of the CREATE and resolves the name itself.
		const fresh = new RemoteOpReplayer(imap, folders);
		const outcome = await fresh.apply(
			op({ kind: 'flags', rfc822MessageId: 'a@x', source: target, flags: { seen: true } })
		);
		expect(outcome).toBe('done');
		expect(imap.log.at(-1)).toMatch(/^\+FLAGS INBOX\.Projects\.Owlat \d+ \\Seen$/);
	});

	it('creates a missing system folder under its conventional name', async () => {
		const imap = new FakeImap({ INBOX: [[1, '<a@x>']] });
		const folders = folderMap({ inbox: 'INBOX' });
		const replayer = new RemoteOpReplayer(imap, folders);

		await replayer.apply(
			op({
				kind: 'move',
				rfc822MessageId: 'a@x',
				source: { role: 'inbox' },
				target: { role: 'archive' },
			})
		);

		expect(imap.ids('Archive')).toEqual(['<a@x>']);
		expect(folders.byRole.get('archive')).toBe('Archive');
	});

	it('sets and clears flags in one op', async () => {
		const imap = new FakeImap({ INBOX: [[1, '<a@x>']] });
		const replayer = new RemoteOpReplayer(imap, folderMap({ inbox: 'INBOX' }));

		await replayer.apply(
			op({
				kind: 'flags',
				rfc822MessageId: 'a@x',
				source: { role: 'inbox' },
				flags: { seen: true, flagged: false, answered: true },
			})
		);

		expect(imap.log).toEqual(['+FLAGS INBOX 1 \\Seen \\Answered', '-FLAGS INBOX 1 \\Flagged']);
	});

	it('deletes only from the folder the op names', async () => {
		const imap = new FakeImap({ INBOX: [[1, '<a@x>']], Trash: [] });
		const replayer = new RemoteOpReplayer(imap, folderMap({ inbox: 'INBOX', trash: 'Trash' }));

		const outcome = await replayer.apply(
			op({ kind: 'delete', rfc822MessageId: 'a@x', source: { role: 'trash' } })
		);

		expect(outcome).toBe('not_found');
		expect(imap.ids('INBOX')).toEqual(['<a@x>']);
	});

	it('never deletes from Gmail All Mail', async () => {
		const gmail = new FakeImap({ '[Gmail]/All Mail': [[9, '<g@x>']] });
		const replayer = new RemoteOpReplayer(
			gmail,
			folderMap({ archive: '[Gmail]/All Mail' }, ['[Gmail]/All Mail'])
		);

		await replayer.apply(
			op({ kind: 'delete', rfc822MessageId: 'g@x', source: { role: 'archive' } })
		);

		expect(gmail.log).toEqual([]);
	});
});

describe('drainRemoteOps', () => {
	function harness(pages: RemoteOp[][], imap: FakeImap) {
		const settled: RemoteOpResult[][] = [];
		const errors: string[] = [];
		const queue = [...pages];
		return {
			settled,
			errors,
			deps: {
				listDue: async () => queue.shift() ?? [],
				settle: async (results: RemoteOpResult[]) => void settled.push(results),
				replayer: new RemoteOpReplayer(imap, folderMap(STANDARD)),
				client: imap,
				isStopped: () => false,
				onError: (o: RemoteOp) => void errors.push(o.opId),
			},
		};
	}

	it('works through every page and settles each op', async () => {
		const imap = new FakeImap({
			INBOX: [
				[1, '<a@x>'],
				[2, '<b@x>'],
			],
			Archive: [],
			Trash: [],
			Sent: [],
		});
		const a = op({
			kind: 'move',
			rfc822MessageId: 'a@x',
			source: { role: 'inbox' },
			target: { role: 'archive' },
		});
		const gone = op({
			kind: 'flags',
			rfc822MessageId: 'zz@x',
			source: { role: 'inbox' },
			flags: { seen: true },
		});
		const b = op({
			kind: 'move',
			rfc822MessageId: 'b@x',
			source: { role: 'inbox' },
			target: { role: 'archive' },
		});
		const h = harness([[a, gone], [b]], imap);

		await drainRemoteOps(h.deps);

		expect(h.settled).toEqual([
			[
				{ opId: a.opId, outcome: 'done' },
				{ opId: gone.opId, outcome: 'not_found' },
			],
			[{ opId: b.opId, outcome: 'done' }],
		]);
	});

	it('settles a failing op as failed and carries on with the rest', async () => {
		const imap = new FakeImap({
			INBOX: [
				[1, '<a@x>'],
				[2, '<b@x>'],
			],
			Archive: [],
			Trash: [],
			Sent: [],
		});
		imap.messageFlagsAdd = async () => {
			throw new Error('NO [OVERQUOTA]');
		};
		const bad = op({
			kind: 'flags',
			rfc822MessageId: 'a@x',
			source: { role: 'inbox' },
			flags: { seen: true },
		});
		const good = op({
			kind: 'move',
			rfc822MessageId: 'b@x',
			source: { role: 'inbox' },
			target: { role: 'archive' },
		});
		const h = harness([[bad, good]], imap);

		await drainRemoteOps(h.deps);

		expect(h.settled).toEqual([
			[
				{ opId: bad.opId, outcome: 'failed', error: 'NO [OVERQUOTA]' },
				{ opId: good.opId, outcome: 'done' },
			],
		]);
	});

	it('stops on a lost connection without charging the op an attempt', async () => {
		const imap = new FakeImap({ INBOX: [[1, '<a@x>']], Archive: [], Trash: [], Sent: [] });
		imap.messageMove = async () => {
			imap.usable = false;
			throw new Error('Connection not available');
		};
		const first = op({
			kind: 'move',
			rfc822MessageId: 'a@x',
			source: { role: 'inbox' },
			target: { role: 'archive' },
		});
		const second = op({
			kind: 'flags',
			rfc822MessageId: 'a@x',
			source: { role: 'inbox' },
			flags: { seen: true },
		});
		const h = harness([[first, second]], imap);

		await drainRemoteOps(h.deps);

		expect(h.settled).toEqual([]);
		expect(h.errors).toEqual([first.opId]);
	});
});
