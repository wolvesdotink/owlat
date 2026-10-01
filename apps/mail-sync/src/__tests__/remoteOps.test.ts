/**
 * Replaying Owlat's write-back queue on the provider (remoteOps.ts), against an
 * in-memory IMAP server. What matters, in order:
 *   - the change lands on the right message: a header search is a substring
 *     match, so only an envelope-confirmed Message-ID is acted on;
 *   - nothing is lost: Gmail's All Mail is copied out of, never moved or
 *     deleted from, and a delete only ever touches the folder it names;
 *   - a message filed before the queue existed is still found in the other
 *     synced folders;
 *   - user folders are created once, under the server's namespace;
 *   - only a folder the server confirms is missing counts as absent: a refused
 *     SELECT, STATUS or SEARCH fails the op so it is retried, and a lost
 *     connection leaves it uncharged.
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

/** An error shaped like the one ImapFlow rejects a refused command with. */
function refused(
	responseStatus: 'NO' | 'BAD',
	serverResponseCode: string | undefined,
	responseText: string,
	extra: Record<string, unknown> = {}
): Error {
	return Object.assign(new Error('Command failed'), {
		responseStatus,
		serverResponseCode,
		responseText,
		...extra,
	});
}

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
		if (range === '1:*') return [...this.box()];
		const uids = new Set(range.split(',').map(Number));
		return this.box().filter((m) => uids.has(m.uid));
	}

	private put(path: string, messages: FakeMessage[]): void {
		const target = this.boxes.get(path);
		if (!target) throw new Error(`NO [TRYCREATE] ${path}`);
		for (const m of messages) target.push({ ...m, uid: this.nextUid++, flags: new Set(m.flags) });
	}

	async getMailboxLock(path: string) {
		// ImapFlow runs LIST after a refused SELECT and marks the error when the folder is not listed.
		if (!this.boxes.has(path)) {
			throw refused('NO', 'NONEXISTENT', 'Unknown Mailbox', { mailboxMissing: true });
		}
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

	async mailboxRename(path: string, newPath: string) {
		const box = this.boxes.get(path);
		if (!box) throw new Error(`NO [NONEXISTENT] ${path}`);
		this.log.push(`RENAME ${path} -> ${newPath}`);
		this.boxes.delete(path);
		this.boxes.set(newPath, box);
	}

	async mailboxDelete(path: string) {
		this.log.push(`DELETE-FOLDER ${path}`);
		this.boxes.delete(path);
	}

	async status(path: string): Promise<{ messages?: number } | false> {
		const box = this.boxes.get(path);
		// What ImapFlow throws once LIST confirms a refused STATUS named no folder.
		if (!box)
			throw Object.assign(new Error(`Mailbox doesn't exist: ${path}`), { code: 'NotFound' });
		return { messages: box.length };
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

describe('RemoteOpReplayer — folders', () => {
	it('renames a mirrored folder in place and sends later ops after it', async () => {
		const imap = new FakeImap({ INBOX: [[1, '<a@x>']], 'Projects/Owlat': [] });
		const folders = { ...folderMap({ inbox: 'INBOX' }), renamed: new Map<string, string>() };
		const replayer = new RemoteOpReplayer(imap, folders);

		const outcome = await replayer.apply(
			op({
				kind: 'renameFolder',
				source: { remote: 'Projects/Owlat' },
				target: { path: ['Clients'] },
			})
		);
		// Queued before the backend learned the new name.
		await replayer.apply(
			op({
				kind: 'move',
				rfc822MessageId: 'a@x',
				source: { role: 'inbox' },
				target: { remote: 'Projects/Owlat' },
			})
		);

		expect(outcome).toBe('done');
		expect(imap.ids('Projects/Clients')).toEqual(['<a@x>']);
		expect(imap.boxes.has('Projects/Owlat')).toBe(false);
	});

	it('moves what the provider still holds to the inbox before deleting a folder', async () => {
		const imap = new FakeImap({ INBOX: [], Receipts: [[5, '<r@x>']] });
		const replayer = new RemoteOpReplayer(imap, folderMap({ inbox: 'INBOX' }));

		const outcome = await replayer.apply(
			op({ kind: 'deleteFolder', source: { remote: 'Receipts' } })
		);

		expect(outcome).toBe('done');
		expect(imap.log).toEqual(['MOVE Receipts 1:* -> INBOX', 'DELETE-FOLDER Receipts']);
		expect(imap.ids('INBOX')).toEqual(['<r@x>']);
	});

	it('never renames or deletes a system folder, and skips one the provider lacks', async () => {
		const imap = new FakeImap({ INBOX: [], Archive: [] });
		const replayer = new RemoteOpReplayer(imap, folderMap({ inbox: 'INBOX', archive: 'Archive' }));

		expect(await replayer.apply(op({ kind: 'deleteFolder', source: { remote: 'Archive' } }))).toBe(
			'not_found'
		);
		expect(
			await replayer.apply(
				op({ kind: 'renameFolder', source: { remote: 'INBOX' }, target: { path: ['X'] } })
			)
		).toBe('not_found');
		expect(await replayer.apply(op({ kind: 'deleteFolder', source: { remote: 'Gone' } }))).toBe(
			'not_found'
		);
		expect(imap.log).toEqual([]);
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

describe('RemoteOpReplayer — a refused SELECT or STATUS is not a missing folder', () => {
	const unavailable = () => refused('NO', 'UNAVAILABLE', 'Temporary server failure');
	const throttled = () =>
		Object.assign(refused('BAD', undefined, 'Request is throttled.'), {
			code: 'ETHROTTLE',
			throttleReset: 30_000,
		});
	const noPermission = () => refused('NO', 'NOPERM', 'Access denied');

	function settledFor(imap: FakeImap, operation: RemoteOp) {
		const settled: RemoteOpResult[][] = [];
		return {
			settled,
			run: () =>
				drainRemoteOps({
					listDue: (() => {
						let served = false;
						return async () => (served ? [] : ((served = true), [operation]));
					})(),
					settle: async (results) => void settled.push(results),
					replayer: new RemoteOpReplayer(imap, folderMap(STANDARD)),
					client: imap,
					isStopped: () => false,
					onError: () => {},
				}),
		};
	}

	const deleteFromTrash = () =>
		op({ kind: 'delete', rfc822MessageId: 'a@x', source: { role: 'trash' } });

	it('retires a message op whose folder the server confirms does not exist', async () => {
		const imap = new FakeImap({ INBOX: [[1, '<a@x>']] });
		const h = settledFor(imap, deleteFromTrash());

		await h.run();

		expect(h.settled[0]).toEqual([expect.objectContaining({ outcome: 'not_found' })]);
	});

	it.each([
		[
			'a temporary UNAVAILABLE',
			unavailable,
			'Command failed: NO [UNAVAILABLE] Temporary server failure',
		],
		['throttling', throttled, 'Command failed (ETHROTTLE): BAD Request is throttled.'],
		['a permission refusal', noPermission, 'Command failed: NO [NOPERM] Access denied'],
	])('retries a message op when SELECT meets %s', async (_name, error, recorded) => {
		const imap = new FakeImap({ INBOX: [], Archive: [], Trash: [[1, '<a@x>']], Sent: [] });
		imap.getMailboxLock = async () => {
			throw error();
		};
		const operation = deleteFromTrash();
		const h = settledFor(imap, operation);

		await h.run();

		expect(h.settled).toEqual([[{ opId: operation.opId, outcome: 'failed', error: recorded }]]);
		expect(imap.ids('Trash')).toEqual(['<a@x>']);
	});

	it('retries a move when the fallback folders cannot be selected, instead of calling it gone', async () => {
		// The op's own folder no longer holds it; Archive, where it now sits, is briefly unavailable.
		const imap = new FakeImap({ INBOX: [], Archive: [[4, '<a@x>']], Trash: [], Sent: [] });
		const select = imap.getMailboxLock.bind(imap);
		imap.getMailboxLock = async (path) => {
			if (path === 'Archive') throw unavailable();
			return await select(path);
		};
		const operation = op({
			kind: 'move',
			rfc822MessageId: 'a@x',
			source: { role: 'inbox' },
			target: { role: 'trash' },
		});
		const h = settledFor(imap, operation);

		await h.run();

		expect(h.settled[0]).toEqual([expect.objectContaining({ outcome: 'failed' })]);
	});

	it('still finds the message in a later folder when an earlier one cannot be selected', async () => {
		const imap = new FakeImap({ INBOX: [], Archive: [], Trash: [[4, '<a@x>']], Sent: [] });
		const select = imap.getMailboxLock.bind(imap);
		imap.getMailboxLock = async (path) => {
			if (path === 'Archive') throw unavailable();
			return await select(path);
		};
		const operation = op({
			kind: 'flags',
			rfc822MessageId: 'a@x',
			source: { role: 'inbox' },
			flags: { flagged: true },
		});
		const h = settledFor(imap, operation);

		await h.run();

		expect(h.settled).toEqual([[{ opId: operation.opId, outcome: 'done' }]]);
		expect(imap.log).toEqual(['+FLAGS Trash 4 \\Flagged']);
	});

	it('retries when SEARCH is refused rather than reading it as no match', async () => {
		const imap = new FakeImap({ INBOX: [[1, '<a@x>']], Archive: [], Trash: [], Sent: [] });
		imap.search = async () => false;
		const operation = op({
			kind: 'flags',
			rfc822MessageId: 'a@x',
			source: { role: 'inbox' },
			flags: { seen: true },
		});
		const h = settledFor(imap, operation);

		await h.run();

		expect(h.settled).toEqual([
			[{ opId: operation.opId, outcome: 'failed', error: 'SEARCH failed' }],
		]);
	});

	it('retires a folder op whose folder STATUS confirms is gone', async () => {
		const imap = new FakeImap({ INBOX: [] });
		const replayer = new RemoteOpReplayer(imap, folderMap({ inbox: 'INBOX' }));

		expect(await replayer.apply(op({ kind: 'deleteFolder', source: { remote: 'Receipts' } }))).toBe(
			'not_found'
		);
		expect(
			await replayer.apply(
				op({ kind: 'renameFolder', source: { remote: 'Receipts' }, target: { path: ['R'] } })
			)
		).toBe('not_found');
	});

	it.each([
		['throws UNAVAILABLE', async () => Promise.reject(unavailable())],
		['throws a throttling error', async () => Promise.reject(throttled())],
		['is refused for permission', async () => Promise.reject(noPermission())],
		// ImapFlow's answer when the server refuses STATUS of a folder LIST still shows.
		['resolves false', async () => false as const],
	])(
		'keeps a folder delete queued, and its mail in place, when STATUS %s',
		async (_name, status) => {
			const imap = new FakeImap({ INBOX: [], Receipts: [[5, '<r@x>']] });
			imap.status = status;
			const operation = op({ kind: 'deleteFolder', source: { remote: 'Receipts' } });
			const h = settledFor(imap, operation);

			await h.run();

			expect(h.settled[0]).toEqual([expect.objectContaining({ outcome: 'failed' })]);
			expect(imap.log).toEqual([]);
			expect(imap.ids('Receipts')).toEqual(['<r@x>']);
		}
	);

	it('keeps a folder rename queued when STATUS is refused', async () => {
		const imap = new FakeImap({ INBOX: [], Receipts: [] });
		imap.status = async () => Promise.reject(unavailable());
		const operation = op({
			kind: 'renameFolder',
			source: { remote: 'Receipts' },
			target: { path: ['Invoices'] },
		});
		const h = settledFor(imap, operation);

		await h.run();

		expect(h.settled[0]).toEqual([expect.objectContaining({ outcome: 'failed' })]);
		expect(imap.boxes.has('Receipts')).toBe(true);
	});

	it.each([
		[
			'SELECT',
			(imap: FakeImap) => {
				imap.getMailboxLock = async () => {
					imap.usable = false;
					throw new Error('Connection not available');
				};
				return deleteFromTrash();
			},
		],
		[
			'STATUS',
			(imap: FakeImap) => {
				// ImapFlow swallows the dropped STATUS into `false`; the connection says why.
				imap.status = async () => {
					imap.usable = false;
					return false;
				};
				return op({ kind: 'deleteFolder', source: { remote: 'Receipts' } });
			},
		],
	])('leaves the op uncharged when the connection drops during %s', async (_name, arrange) => {
		const imap = new FakeImap({ INBOX: [], Trash: [[1, '<a@x>']], Receipts: [] });
		const h = settledFor(imap, arrange(imap));

		await h.run();

		expect(h.settled).toEqual([]);
	});
});
