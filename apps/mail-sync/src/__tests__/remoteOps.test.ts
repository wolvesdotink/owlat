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
 *     connection leaves it uncharged;
 *   - a MOVE, COPY, STORE or EXPUNGE the server refuses (ImapFlow resolves
 *     `false`) fails the op with the server's answer, never settles it as
 *     done, and never lets a folder be deleted with mail still in it;
 *   - a flag the folder cannot keep is skipped, not retried;
 *   - a folder rename is handed to the backend, so a restart loses nothing:
 *     the op is done only once the backend has the new name, a retry reports
 *     again, and a restarted worker reports a rename it carried out before any
 *     op for the old name runs.
 */

import { describe, expect, it } from 'vitest';
import { getFunctionName } from 'convex/server';
import { RemoteOpReplayer } from '../remoteOps.js';
import type {
	RemoteFolderMap,
	RemoteOp,
	RemoteOpResult,
	RemoteOpsClient,
	ReplayHooks,
} from '../remoteOpTypes.js';
import { drainRemoteOps, reportFolderRename } from '../remoteOpsDrain.js';
import { fn, isMissingFunction } from '../convex.js';
import { CommandRefusals } from '../imapCommandErrors.js';
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

/** The commands a FakeImap can be told to refuse, by the name its log uses. */
type Refusable = 'MOVE' | 'COPY' | '+FLAGS' | '-FLAGS' | 'EXPUNGE';

/**
 * An IMAP server behind ImapFlow: an action command the server refuses is
 * logged through the client's logger and resolves `false`, as ImapFlow does.
 */
class FakeImap implements RemoteOpsClient {
	usable = true;
	namespace: { prefix: string; delimiter: string } = { prefix: '', delimiter: '/' };
	capabilities = new Map<string, boolean | number>([
		['MOVE', true],
		['UIDPLUS', true],
	]);
	enabled = new Set<string>();
	/** PERMANENTFLAGS of every folder; undefined when the server sends none. */
	permanentFlags: Set<string> | undefined;
	readonly refusals = new CommandRefusals();
	/** Commands the server refuses, with the error ImapFlow logs for each. */
	readonly refuse = new Map<Refusable, Error>();
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
		const target = this.boxes.get(path)!;
		for (const m of messages) target.push({ ...m, uid: this.nextUid++, flags: new Set(m.flags) });
	}

	/** Log a refusal the way ImapFlow does, and answer `false`; null when the command goes through. */
	private refused(command: Refusable, destination?: string): false | null {
		let err = this.refuse.get(command);
		if (!err && destination !== undefined && !this.boxes.has(destination)) {
			err = refused('NO', 'TRYCREATE', 'Mailbox does not exist');
		}
		if (!err) return null;
		this.log.push(`${command} refused`);
		this.refusals.logger.warn({ err, cid: 'fake' });
		return false;
	}

	get mailbox() {
		return this.selected === null ? (false as const) : { permanentFlags: this.permanentFlags };
	}

	async getMailboxLock(path: string) {
		// ImapFlow runs LIST after a refused SELECT and marks the error when the folder is not listed.
		if (!this.boxes.has(path)) {
			throw refused('NO', 'NONEXISTENT', 'Unknown Mailbox', { mailboxMissing: true });
		}
		this.selected = path;
		return { release: () => void (this.selected = null) };
	}

	async search(query: { header: Record<string, string> }): Promise<number[] | false | undefined> {
		const needle = query.header['message-id'] ?? '';
		return this.box()
			.filter((m) => m.messageId.includes(needle))
			.map((m) => m.uid);
	}

	async *fetch(range: string) {
		for (const m of this.take(range)) yield { uid: m.uid, envelope: { messageId: m.messageId } };
	}

	async messageMove(range: string, destination: string, _options?: { uid: true }) {
		if (!this.capabilities.has('MOVE')) {
			// ImapFlow's fallback: COPY, then STORE \Deleted + EXPUNGE whatever the COPY answered.
			const copied = await this.messageCopy(range, destination);
			await this.messageDelete(range);
			return copied;
		}
		const refusal = this.refused('MOVE', destination);
		if (refusal !== null) return refusal;
		this.log.push(`MOVE ${this.selected} ${range} -> ${destination}`);
		const moving = this.take(range);
		this.put(destination, moving);
		const box = this.box();
		for (const m of moving) box.splice(box.indexOf(m), 1);
		return { path: this.selected!, destination };
	}

	async messageCopy(range: string, destination: string) {
		const refusal = this.refused('COPY', destination);
		if (refusal !== null) return refusal;
		this.log.push(`COPY ${this.selected} ${range} -> ${destination}`);
		this.put(destination, this.take(range));
		return { path: this.selected!, destination };
	}

	async messageFlagsAdd(range: string, flags: string[], _options?: unknown, quiet = false) {
		// ImapFlow drops, unsent, a flag the folder's PERMANENTFLAGS do not list.
		const p = this.permanentFlags;
		const kept = flags.filter((f) => !p || p.has('\\*') || p.has(f));
		if (kept.length === 0) return false;
		const refusal = this.refused('+FLAGS');
		if (refusal !== null) return refusal;
		if (!quiet) this.log.push(`+FLAGS ${this.selected} ${range} ${kept.join(' ')}`);
		for (const m of this.take(range)) for (const f of kept) m.flags.add(f);
		return true;
	}

	async messageFlagsRemove(range: string, flags: string[]) {
		const refusal = this.refused('-FLAGS');
		if (refusal !== null) return refusal;
		this.log.push(`-FLAGS ${this.selected} ${range} ${flags.join(' ')}`);
		for (const m of this.take(range)) for (const f of flags) m.flags.delete(f);
		return true;
	}

	async messageDelete(range: string) {
		// ImapFlow stores \Deleted first and ignores what that STORE answered.
		await this.messageFlagsAdd(range, ['\\Deleted'], undefined, true);
		const refusal = this.refused('EXPUNGE');
		if (refusal !== null) return refusal;
		this.log.push(`EXPUNGE ${this.selected} ${range}`);
		const box = this.box();
		for (const m of this.take(range)) {
			if (m.flags.has('\\Deleted')) box.splice(box.indexOf(m), 1);
		}
		return true;
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
		return { path, newPath };
	}

	async mailboxDelete(path: string) {
		this.log.push(`DELETE-FOLDER ${path}`);
		this.boxes.delete(path);
		return { path };
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

/** A replayer wired to the fake's refusal log, as connection.ts wires it to ImapFlow's. */
function replayerFor(imap: FakeImap, folders: RemoteFolderMap, hooks: ReplayHooks = {}) {
	return new RemoteOpReplayer(imap, folders, { takeRefusal: () => imap.refusals.take(), ...hooks });
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
		const replayer = replayerFor(imap, folderMap(STANDARD));

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
		const replayer = replayerFor(imap, folderMap(STANDARD));

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
		const replayer = replayerFor(imap, folderMap(STANDARD));

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
		const replayer = replayerFor(imap, folderMap(STANDARD));

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
		const replayer = replayerFor(
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
		const replayer = replayerFor(
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
		const replayer = replayerFor(imap, folders);
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
		const fresh = replayerFor(imap, folders);
		const outcome = await fresh.apply(
			op({ kind: 'flags', rfc822MessageId: 'a@x', source: target, flags: { seen: true } })
		);
		expect(outcome).toBe('done');
		expect(imap.log.at(-1)).toMatch(/^\+FLAGS INBOX\.Projects\.Owlat \d+ \\Seen$/);
	});

	it('creates a missing system folder under its conventional name', async () => {
		const imap = new FakeImap({ INBOX: [[1, '<a@x>']] });
		const folders = folderMap({ inbox: 'INBOX' });
		const replayer = replayerFor(imap, folders);

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
		const replayer = replayerFor(imap, folderMap({ inbox: 'INBOX' }));

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
		const replayer = replayerFor(imap, folderMap({ inbox: 'INBOX', trash: 'Trash' }));

		const outcome = await replayer.apply(
			op({ kind: 'delete', rfc822MessageId: 'a@x', source: { role: 'trash' } })
		);

		expect(outcome).toBe('not_found');
		expect(imap.ids('INBOX')).toEqual(['<a@x>']);
	});

	it('never deletes from Gmail All Mail', async () => {
		const gmail = new FakeImap({ '[Gmail]/All Mail': [[9, '<g@x>']] });
		const replayer = replayerFor(
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
		const replayer = replayerFor(imap, folders);

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
		const replayer = replayerFor(imap, folderMap({ inbox: 'INBOX' }));

		const outcome = await replayer.apply(
			op({ kind: 'deleteFolder', source: { remote: 'Receipts' } })
		);

		expect(outcome).toBe('done');
		expect(imap.log).toEqual(['MOVE Receipts 1:* -> INBOX', 'DELETE-FOLDER Receipts']);
		expect(imap.ids('INBOX')).toEqual(['<r@x>']);
	});

	it('never renames or deletes a system folder, and skips one the provider lacks', async () => {
		const imap = new FakeImap({ INBOX: [], Archive: [] });
		const replayer = replayerFor(imap, folderMap({ inbox: 'INBOX', archive: 'Archive' }));

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
				replayer: replayerFor(imap, folderMap(STANDARD)),
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
					replayer: replayerFor(imap, folderMap(STANDARD)),
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
		const replayer = replayerFor(imap, folderMap({ inbox: 'INBOX' }));

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

/** Drain one op through the replay, as connection.ts does, and return what was settled. */
async function drainOne(
	imap: FakeImap,
	operation: RemoteOp,
	folders: RemoteFolderMap = folderMap(STANDARD),
	hooks: ReplayHooks = {}
): Promise<RemoteOpResult[][]> {
	const settled: RemoteOpResult[][] = [];
	let served = false;
	await drainRemoteOps({
		listDue: async () => (served ? [] : ((served = true), [operation])),
		settle: async (results) => void settled.push(results),
		replayer: replayerFor(imap, folders, hooks),
		client: imap,
		isStopped: () => false,
		onError: () => {},
	});
	return settled;
}

describe('RemoteOpReplayer — a refused MOVE, COPY, STORE or EXPUNGE is not done', () => {
	const overQuota = () => refused('NO', 'OVERQUOTA', 'Quota exceeded');
	const archive = () =>
		op({
			kind: 'move',
			rfc822MessageId: 'a@x',
			source: { role: 'inbox' },
			target: { role: 'archive' },
		});

	function mailbox() {
		return new FakeImap({ INBOX: [[1, '<a@x>']], Archive: [], Trash: [[2, '<t@x>']], Sent: [] });
	}

	it('fails a move the server refuses, with its answer, and leaves the message where it was', async () => {
		const imap = mailbox();
		imap.refuse.set('MOVE', overQuota());
		const operation = archive();

		const settled = await drainOne(imap, operation);

		expect(settled).toEqual([
			[
				{
					opId: operation.opId,
					outcome: 'failed',
					error: 'MOVE failed: NO [OVERQUOTA] Quota exceeded',
				},
			],
		]);
		expect(imap.ids('INBOX')).toEqual(['<a@x>']);
		expect(imap.ids('Archive')).toEqual([]);
	});

	it('fails a move into a folder the provider no longer has instead of calling it done', async () => {
		// An op still naming a folder renamed away: the server answers TRYCREATE.
		const imap = mailbox();
		const operation = op({
			kind: 'move',
			rfc822MessageId: 'a@x',
			source: { role: 'inbox' },
			target: { remote: 'Projects/Owlat' },
		});

		const settled = await drainOne(imap, operation);

		expect(settled[0]).toEqual([
			expect.objectContaining({ outcome: 'failed', error: expect.stringContaining('[TRYCREATE]') }),
		]);
		expect(imap.ids('INBOX')).toEqual(['<a@x>']);
	});

	it('fails a copy out of Gmail All Mail the server refuses', async () => {
		const gmail = new FakeImap({ INBOX: [], '[Gmail]/All Mail': [[9, '<g@x>']] });
		gmail.refuse.set('COPY', overQuota());
		const operation = op({
			kind: 'move',
			rfc822MessageId: 'g@x',
			source: { role: 'archive' },
			target: { role: 'inbox' },
		});

		const settled = await drainOne(
			gmail,
			operation,
			folderMap({ inbox: 'INBOX', archive: '[Gmail]/All Mail' }, ['[Gmail]/All Mail'])
		);

		expect(settled[0]).toEqual([
			expect.objectContaining({
				outcome: 'failed',
				error: 'COPY failed: NO [OVERQUOTA] Quota exceeded',
			}),
		]);
		expect(gmail.ids('INBOX')).toEqual([]);
	});

	it.each([
		['setting', '+FLAGS', { seen: true }],
		['clearing', '-FLAGS', { seen: false }],
	] as const)('fails %s a flag the server refuses', async (_name, command, flags) => {
		const imap = mailbox();
		imap.refuse.set(command, refused('NO', undefined, 'STORE not permitted'));
		const operation = op({
			kind: 'flags',
			rfc822MessageId: 'a@x',
			source: { role: 'inbox' },
			flags,
		});

		const settled = await drainOne(imap, operation);

		expect(settled).toEqual([
			[{ opId: operation.opId, outcome: 'failed', error: 'STORE failed: NO STORE not permitted' }],
		]);
	});

	it('fails a delete whose EXPUNGE the server refuses', async () => {
		const imap = mailbox();
		imap.refuse.set('EXPUNGE', refused('NO', 'EXPUNGEISSUED', 'Expunge failed'));
		const operation = op({ kind: 'delete', rfc822MessageId: 't@x', source: { role: 'trash' } });

		const settled = await drainOne(imap, operation);

		expect(settled[0]).toEqual([
			expect.objectContaining({
				outcome: 'failed',
				error: 'EXPUNGE failed: NO [EXPUNGEISSUED] Expunge failed',
			}),
		]);
		expect(imap.ids('Trash')).toEqual(['<t@x>']);
	});

	it('fails a delete whose STORE \\Deleted is refused, without expunging', async () => {
		// ImapFlow's messageDelete would report the EXPUNGE alone, which removes nothing.
		const imap = mailbox();
		imap.refuse.set('+FLAGS', refused('NO', undefined, 'Permission denied'));
		const operation = op({ kind: 'delete', rfc822MessageId: 't@x', source: { role: 'trash' } });

		const settled = await drainOne(imap, operation);

		expect(settled[0]).toEqual([
			expect.objectContaining({ outcome: 'failed', error: 'STORE failed: NO Permission denied' }),
		]);
		expect(imap.log.some((line) => line.startsWith('EXPUNGE'))).toBe(false);
		expect(imap.ids('Trash')).toEqual(['<t@x>']);
	});

	it('leaves the op uncharged when the connection drops under a MOVE', async () => {
		const imap = mailbox();
		imap.messageMove = async () => {
			imap.usable = false;
			return false; // ImapFlow swallows the dropped command into `false` too
		};

		expect(await drainOne(imap, archive())).toEqual([]);
	});

	describe('on a server without MOVE', () => {
		function withoutMove() {
			const imap = mailbox();
			imap.capabilities.delete('MOVE');
			return imap;
		}

		it('moves with COPY, then expunges the original', async () => {
			const imap = withoutMove();

			const settled = await drainOne(imap, archive());

			expect(settled[0]).toEqual([expect.objectContaining({ outcome: 'done' })]);
			expect(imap.log).toEqual([
				'COPY INBOX 1 -> Archive',
				'+FLAGS INBOX 1 \\Deleted',
				'EXPUNGE INBOX 1',
			]);
			expect(imap.ids('INBOX')).toEqual([]);
			expect(imap.ids('Archive')).toEqual(['<a@x>']);
		});

		it('never expunges the original when the COPY is refused', async () => {
			const imap = withoutMove();
			imap.refuse.set('COPY', overQuota());

			const settled = await drainOne(imap, archive());

			expect(settled[0]).toEqual([
				expect.objectContaining({
					outcome: 'failed',
					error: 'COPY failed: NO [OVERQUOTA] Quota exceeded',
				}),
			]);
			expect(imap.ids('INBOX')).toEqual(['<a@x>']);
			expect(imap.log).toEqual(['COPY refused']);
		});

		it('uses MOVE where IMAP4rev2 includes it', async () => {
			const imap = withoutMove();
			// RFC 9051 folds MOVE into IMAP4rev2; ImapFlow then sends MOVE without listing it.
			imap.enabled.add('IMAP4REV2');
			const moves: string[] = [];
			imap.messageMove = async (range, destination) => {
				moves.push(`${range} -> ${destination}`);
				return { path: 'INBOX', destination };
			};

			await drainOne(imap, archive());

			expect(moves).toEqual(['1 -> Archive']);
		});
	});
});

describe('RemoteOpReplayer — a flag the folder cannot keep', () => {
	it('stores the flags the folder keeps and reports the rest as skipped, without retrying', async () => {
		const imap = new FakeImap({ INBOX: [[1, '<a@x>']] });
		imap.permanentFlags = new Set(['\\Seen', '\\Deleted']);
		const skipped: string[] = [];
		const operation = op({
			kind: 'flags',
			rfc822MessageId: 'a@x',
			source: { role: 'inbox' },
			flags: { seen: true, flagged: true },
		});

		const settled = await drainOne(imap, operation, folderMap({ inbox: 'INBOX' }), {
			skipped: (_op, reason) => void skipped.push(reason),
		});

		expect(settled).toEqual([[{ opId: operation.opId, outcome: 'done' }]]);
		expect(imap.log).toEqual(['+FLAGS INBOX 1 \\Seen']);
		expect(skipped).toEqual(["the folder's PERMANENTFLAGS do not allow \\Flagged"]);
	});

	it('settles an op whose only flag the folder cannot keep, sending nothing', async () => {
		const imap = new FakeImap({ INBOX: [[1, '<a@x>']] });
		imap.permanentFlags = new Set(['\\Seen']);
		const operation = op({
			kind: 'flags',
			rfc822MessageId: 'a@x',
			source: { role: 'inbox' },
			flags: { flagged: true },
		});

		const settled = await drainOne(imap, operation, folderMap({ inbox: 'INBOX' }));

		expect(settled).toEqual([[{ opId: operation.opId, outcome: 'done' }]]);
		expect(imap.log).toEqual([]);
	});

	it('stores any flag in a folder whose PERMANENTFLAGS include \\*', async () => {
		const imap = new FakeImap({ INBOX: [[1, '<a@x>']] });
		imap.permanentFlags = new Set(['\\*']);

		await drainOne(
			imap,
			op({
				kind: 'flags',
				rfc822MessageId: 'a@x',
				source: { role: 'inbox' },
				flags: { flagged: true },
			}),
			folderMap({ inbox: 'INBOX' })
		);

		expect(imap.log).toEqual(['+FLAGS INBOX 1 \\Flagged']);
	});
});

describe('RemoteOpReplayer — deleting a folder whose mail could not be moved out', () => {
	const deleteReceipts = () => op({ kind: 'deleteFolder', source: { remote: 'Receipts' } });

	it('keeps the folder, and its mail, when the server refuses the move', async () => {
		const imap = new FakeImap({ INBOX: [], Receipts: [[5, '<r@x>']] });
		imap.refuse.set('MOVE', refused('NO', 'OVERQUOTA', 'Quota exceeded'));
		const operation = deleteReceipts();

		const settled = await drainOne(imap, operation, folderMap({ inbox: 'INBOX' }));

		expect(settled).toEqual([
			[
				{
					opId: operation.opId,
					outcome: 'failed',
					error: 'MOVE failed: NO [OVERQUOTA] Quota exceeded',
				},
			],
		]);
		expect(imap.log).not.toContain('DELETE-FOLDER Receipts');
		expect(imap.ids('Receipts')).toEqual(['<r@x>']);
	});

	it('keeps the folder on a server without MOVE when the COPY is refused', async () => {
		const imap = new FakeImap({ INBOX: [], Receipts: [[5, '<r@x>']] });
		imap.capabilities.delete('MOVE');
		imap.refuse.set('COPY', refused('NO', 'OVERQUOTA', 'Quota exceeded'));

		const settled = await drainOne(imap, deleteReceipts(), folderMap({ inbox: 'INBOX' }));

		expect(settled[0]).toEqual([expect.objectContaining({ outcome: 'failed' })]);
		expect(imap.boxes.has('Receipts')).toBe(true);
		expect(imap.ids('Receipts')).toEqual(['<r@x>']);
		expect(imap.ids('INBOX')).toEqual([]);
	});

	it('keeps the folder when mail is still in it after the move', async () => {
		const imap = new FakeImap({ INBOX: [], Receipts: [[5, '<r@x>']] });
		const move = imap.messageMove.bind(imap);
		imap.messageMove = async (range, destination, options) => {
			const result = await move(range, destination, options);
			imap.boxes.get('Receipts')!.push({ uid: 6, messageId: '<new@x>', flags: new Set() });
			return result;
		};

		const settled = await drainOne(imap, deleteReceipts(), folderMap({ inbox: 'INBOX' }));

		expect(settled[0]).toEqual([
			expect.objectContaining({
				outcome: 'failed',
				error: 'DELETE withheld: the folder still holds 1 messages',
			}),
		]);
		expect(imap.ids('Receipts')).toEqual(['<new@x>']);
	});
});

describe('RemoteOpReplayer — a folder rename survives a worker restart', () => {
	const renameToClients = () =>
		op({
			kind: 'renameFolder',
			source: { remote: 'Projects/Owlat' },
			target: { path: ['Clients'] },
		});

	it('hands the new remote name and the delimiter to the backend', async () => {
		const imap = new FakeImap({ INBOX: [], 'Projects/Owlat': [] });
		const renames: unknown[] = [];
		const operation = renameToClients();

		await drainOne(imap, operation, folderMap({ inbox: 'INBOX' }), {
			renamed: async (o, rename) => void renames.push([o.opId, rename]),
		});

		expect(renames).toEqual([
			[operation.opId, { from: 'Projects/Owlat', to: 'Projects/Clients', delimiter: '/' }],
		]);
	});

	it('reaches the renamed folder after a restart once the backend has rewritten the op', async () => {
		const imap = new FakeImap({ INBOX: [[1, '<a@x>']], 'Projects/Owlat': [[2, '<b@x>']] });
		// The backend's side of the rename: queued ops naming the old folder now name the new one.
		const queued = [
			op({
				kind: 'flags',
				rfc822MessageId: 'b@x',
				source: { remote: 'Projects/Owlat' },
				flags: { seen: true },
			}),
			op({
				kind: 'move',
				rfc822MessageId: 'a@x',
				source: { role: 'inbox' },
				target: { remote: 'Projects/Owlat' },
			}),
		];
		const rewrite = async (_op: RemoteOp, { from, to }: { from: string; to: string }) => {
			for (const o of queued) {
				for (const ref of [o.source, o.target]) {
					if (ref && 'remote' in ref && ref.remote === from) ref.remote = to;
				}
			}
		};
		await drainOne(
			imap,
			renameToClients(),
			{ ...folderMap({ inbox: 'INBOX' }), renamed: new Map() },
			{
				renamed: rewrite,
			}
		);

		// A restart: a new connection, with nothing remembered of the rename.
		const restarted = { ...folderMap({ inbox: 'INBOX' }), renamed: new Map<string, string>() };
		const settled = [
			...(await drainOne(imap, queued[0]!, restarted)),
			...(await drainOne(imap, queued[1]!, restarted)),
		];

		expect(settled.flat().map((r) => r.outcome)).toEqual(['done', 'done']);
		expect(imap.ids('Projects/Clients')).toEqual(['<b@x>', '<a@x>']);
		expect(imap.log).toContain('+FLAGS Projects/Clients 2 \\Seen');
	});

	it('settles a rename a restart cut off after RENAME, and still hands it to the backend', async () => {
		// RENAME went through, but the worker stopped before the op settled.
		const imap = new FakeImap({ INBOX: [], 'Projects/Clients': [] });
		const renames: unknown[] = [];
		const operation = renameToClients();

		const settled = await drainOne(imap, operation, folderMap({ inbox: 'INBOX' }), {
			renamed: async (_o, rename) => void renames.push(rename),
		});

		expect(settled).toEqual([[{ opId: operation.opId, outcome: 'done' }]]);
		expect(imap.log).toEqual([]);
		expect(renames).toEqual([{ from: 'Projects/Owlat', to: 'Projects/Clients', delimiter: '/' }]);
	});
});

describe('RemoteOpReplayer — a rename whose report did not reach the backend', () => {
	/**
	 * The backend's queue: a recorded rename rewrites every queued op naming the
	 * old folder, the rename op included. Unreachable until `up` is set.
	 */
	function backend(queue: RemoteOp[]) {
		const state = { up: false, reports: [] as Array<{ from: string; to: string }> };
		const renamed: ReplayHooks['renamed'] = async (_op, { from, to }) => {
			await reportFolderRename({
				record: async () => {
					if (!state.up) throw new Error('fetch failed: 503 Service Unavailable');
					state.reports.push({ from, to });
					for (const o of queue) {
						for (const ref of [o.source, o.target]) {
							if (ref && 'remote' in ref && ref.remote === from) ref.remote = to;
						}
					}
				},
				isUnsupported: (err) => isMissingFunction(err, fn.recordRemoteFolderRename),
				sleep: async () => {},
			});
		};
		return { state, hooks: { renamed } satisfies ReplayHooks };
	}

	const renameToClients = () =>
		op({
			kind: 'renameFolder',
			source: { remote: 'Projects/Owlat' },
			target: { path: ['Clients'] },
		});

	it('fails the op after a successful RENAME, and its retry sends the report', async () => {
		const imap = new FakeImap({ INBOX: [], 'Projects/Owlat': [] });
		const rename = renameToClients();
		const { state, hooks } = backend([rename]);
		const folders = { ...folderMap({ inbox: 'INBOX' }), renamed: new Map<string, string>() };

		const first = await drainOne(imap, rename, folders, hooks);
		state.up = true;
		const retry = await drainOne(imap, rename, folders, hooks);

		expect(first).toEqual([[expect.objectContaining({ opId: rename.opId, outcome: 'failed' })]]);
		expect(retry).toEqual([[{ opId: rename.opId, outcome: 'done' }]]);
		expect(state.reports).toEqual([{ from: 'Projects/Owlat', to: 'Projects/Clients' }]);
		// The retry reports what the provider already did; it does not rename again.
		expect(imap.log.filter((line) => line.startsWith('RENAME'))).toEqual([
			'RENAME Projects/Owlat -> Projects/Clients',
		]);
		expect(rename.source).toEqual({ remote: 'Projects/Clients' });
	});

	it('reports the rename on restart before the ops still naming the old folder run', async () => {
		const imap = new FakeImap({ INBOX: [], 'Projects/Owlat': [[2, '<b@x>']] });
		const rename = renameToClients();
		const flags = op({
			kind: 'flags',
			rfc822MessageId: 'b@x',
			source: { remote: 'Projects/Owlat' },
			flags: { seen: true },
		});
		const deleteFolder = op({ kind: 'deleteFolder', source: { remote: 'Projects/Owlat' } });
		const { state, hooks } = backend([rename, flags, deleteFolder]);
		const before = { ...folderMap({ inbox: 'INBOX' }), renamed: new Map<string, string>() };
		expect(await drainOne(imap, rename, before, hooks)).toEqual([
			[expect.objectContaining({ outcome: 'failed' })],
		]);

		// A restart: nothing remembered of the rename, and the backend reachable again.
		state.up = true;
		const after = { ...folderMap({ inbox: 'INBOX' }), renamed: new Map<string, string>() };
		expect(await replayerFor(imap, after, hooks).recoverRenames([rename])).toBe(true);
		const settled = [
			...(await drainOne(imap, flags, after, hooks)),
			// The folder delete waits behind the rename in the backend's queue.
			...(await drainOne(imap, rename, after, hooks)),
			...(await drainOne(imap, deleteFolder, after, hooks)),
		];

		expect(state.reports).toEqual([{ from: 'Projects/Owlat', to: 'Projects/Clients' }]);
		expect(settled.flat().map((r) => r.outcome)).toEqual(['done', 'done', 'done']);
		expect(imap.log).toContain('+FLAGS Projects/Clients 2 \\Seen');
		expect(imap.log).toContain('DELETE-FOLDER Projects/Clients');
		expect(imap.ids('INBOX')).toEqual(['<b@x>']);
	});

	it('leaves a rename the provider has not carried out to its own turn', async () => {
		const imap = new FakeImap({ INBOX: [], 'Projects/Owlat': [] });
		const { state, hooks } = backend([]);
		state.up = true;

		const complete = await replayerFor(imap, folderMap({ inbox: 'INBOX' }), hooks).recoverRenames([
			renameToClients(),
		]);

		expect(complete).toBe(true);
		expect(state.reports).toEqual([]);
		expect(imap.log).toEqual([]);
	});

	it('checks again on the next drain when a folder could not be counted', async () => {
		const imap = new FakeImap({ INBOX: [], 'Projects/Clients': [] });
		imap.status = async () => Promise.reject(refused('NO', 'UNAVAILABLE', 'Try later'));
		const { hooks } = backend([]);

		const complete = await replayerFor(imap, folderMap({ inbox: 'INBOX' }), hooks).recoverRenames([
			renameToClients(),
		]);

		expect(complete).toBe(false);
	});

	/**
	 * The backend as connection.ts calls it: queued renames are listed 50 to a
	 * page in source-name order, a recorded rename rewrites the ops naming the
	 * old folder or one below it, and a backed-off rename is not due.
	 * `pageFails` makes the listing fail from that page on.
	 */
	function convexBackend(queue: RemoteOp[], opts: { pageFails?: number } = {}) {
		const settled: RemoteOpResult[] = [];
		const open = () => queue.filter((o) => !settled.some((r) => r.opId === o.opId));
		const named = (ref: unknown) => getFunctionName(ref as Parameters<typeof getFunctionName>[0]);
		const remoteOf = (o: RemoteOp) => ('remote' in o.source ? o.source.remote : '');
		const convex = {
			query: async (ref: unknown, args: Record<string, unknown>) => {
				if (named(ref) === getFunctionName(fn.listQueuedFolderRenames)) {
					const from = Number(args['cursor'] ?? 0);
					if (opts.pageFails !== undefined && from / 50 >= opts.pageFails) {
						throw new Error('fetch failed: 503 Service Unavailable');
					}
					const renames = open()
						.filter((o) => o.kind === 'renameFolder')
						.sort((a, b) => remoteOf(a).localeCompare(remoteOf(b)));
					return {
						page: renames.slice(from, from + 50),
						isDone: from + 50 >= renames.length,
						continueCursor: String(from + 50),
					};
				}
				if (named(ref) === getFunctionName(fn.listDueRemoteOps)) {
					return open().filter((o) => o.kind !== 'renameFolder');
				}
				throw new Error(`unexpected query ${named(ref)}`);
			},
			mutation: async (ref: unknown, args: Record<string, unknown>) => {
				if (named(ref) === getFunctionName(fn.settleRemoteOps)) {
					settled.push(...(args['results'] as RemoteOpResult[]));
					return null;
				}
				if (named(ref) === getFunctionName(fn.recordRemoteFolderRename)) {
					const rename = queue.find((o) => o.opId === args['opId']);
					if (!rename || !('remote' in rename.source)) return null;
					const from = rename.source.remote;
					const to = args['remoteName'] as string;
					for (const o of queue) {
						for (const ref of [o.source, o.target]) {
							if (
								ref &&
								'remote' in ref &&
								(ref.remote === from || ref.remote.startsWith(`${from}/`))
							) {
								ref.remote = to + ref.remote.slice(from.length);
							}
						}
					}
					return null;
				}
				throw new Error(`unexpected mutation ${named(ref)}`);
			},
		};
		return { convex, settled };
	}

	/** A restarted worker's connection (production `AccountConnection`), its drain reachable. */
	async function restartedConnection(convex: unknown, imap: FakeImap) {
		const { AccountConnection } = await import('../connection.js');
		const connection = new AccountConnection(
			{
				accountId: 'acct_1',
				mailboxId: 'mbx_1',
				imapHost: 'imap.example.com',
				imapPort: 993,
				isImapSecure: true,
				imapUsername: 'me@example.com',
				status: 'connected',
			},
			convex as ConstructorParameters<typeof AccountConnection>[1],
			{} as ConstructorParameters<typeof AccountConnection>[2]
		);
		const internals = connection as unknown as {
			client: unknown;
			drainQueue(client: unknown): Promise<void>;
		};
		internals.client = imap;
		return internals;
	}

	/**
	 * A rename the provider carried out but the backend never recorded, behind
	 * 50 queued renames (not carried out) whose folders sort before it, and a
	 * delete still queued for its old name.
	 */
	async function renameBehindAFullPage() {
		const others = Array.from({ length: 50 }, (_, i) => `A${String(i).padStart(2, '0')}`);
		const imap = new FakeImap({
			INBOX: [],
			'Projects/Owlat': [[2, '<b@x>']],
			...Object.fromEntries(others.map((name) => [name, []])),
		});
		const rename = renameToClients();
		const { hooks } = backend([]);
		const before = { ...folderMap({ inbox: 'INBOX' }), renamed: new Map<string, string>() };
		expect(await drainOne(imap, rename, before, hooks)).toEqual([
			[expect.objectContaining({ outcome: 'failed' })],
		]);
		const queue = [
			...others.map((name) =>
				op({ kind: 'renameFolder', source: { remote: name }, target: { path: [`${name}-new`] } })
			),
			rename,
			op({ kind: 'delete', rfc822MessageId: 'b@x', source: { remote: 'Projects/Owlat' } }),
		];
		return { imap, queue, deletion: queue[queue.length - 1]! };
	}

	it('checks the queued renames past the first page before anything runs', async () => {
		const { imap, queue, deletion } = await renameBehindAFullPage();
		const { convex, settled } = convexBackend(queue);

		await (await restartedConnection(convex, imap)).drainQueue(imap);

		expect(deletion.source).toEqual({ remote: 'Projects/Clients' });
		expect(settled).toEqual([{ opId: deletion.opId, outcome: 'done' }]);
		expect(imap.ids('Projects/Clients')).toEqual([]);
	});

	it('drains nothing while a page of the queued renames could not be read', async () => {
		const { imap, queue, deletion } = await renameBehindAFullPage();
		const { convex, settled } = convexBackend(queue, { pageFails: 1 });
		const connection = await restartedConnection(convex, imap);

		await connection.drainQueue(imap);

		expect(settled).toEqual([]);
		expect(imap.ids('Projects/Clients')).toEqual(['<b@x>']);
		expect(deletion.source).toEqual({ remote: 'Projects/Owlat' });
	});

	it('drains nothing after a restart until every queued rename could be checked', async () => {
		const imap = new FakeImap({ INBOX: [], 'Projects/Owlat': [[2, '<b@x>']] });
		const rename = renameToClients();
		const deletion = op({
			kind: 'delete',
			rfc822MessageId: 'b@x',
			source: { remote: 'Projects/Owlat' },
		});
		// RENAME goes through, its report does not reach the backend, and the op backs off.
		const { hooks } = backend([]);
		const before = { ...folderMap({ inbox: 'INBOX' }), renamed: new Map<string, string>() };
		expect(await drainOne(imap, rename, before, hooks)).toEqual([
			[expect.objectContaining({ outcome: 'failed' })],
		]);

		// A restart, with the delete still queued by the old name. STATUS answers
		// for the old name (gone) but not for the new one.
		const { convex, settled } = convexBackend([rename, deletion]);
		const internals = await restartedConnection(convex, imap);
		const status = imap.status.bind(imap);
		imap.status = async (path) => (path === 'Projects/Clients' ? false : await status(path));

		await internals.drainQueue(imap);

		expect(settled).toEqual([]);
		expect(imap.ids('Projects/Clients')).toEqual(['<b@x>']);

		// STATUS answers again: the rename is reported first, and the delete reaches the renamed folder.
		imap.status = status;
		await internals.drainQueue(imap);

		expect(settled).toEqual([{ opId: deletion.opId, outcome: 'done' }]);
		expect(imap.ids('Projects/Clients')).toEqual([]);
	});

	it('throws on restart when the report still fails, so nothing runs against the old name', async () => {
		const imap = new FakeImap({ INBOX: [], 'Projects/Clients': [] });
		const { hooks } = backend([]);

		await expect(
			replayerFor(imap, folderMap({ inbox: 'INBOX' }), hooks).recoverRenames([renameToClients()])
		).rejects.toThrow('503');
	});
});

describe('reportFolderRename', () => {
	const missing = new Error(
		"[Request ID: 1a2b] Server Error\nCould not find public function for 'mail/external/remoteFolderRename:recordRemoteFolderRename'. Did you forget to run `npx convex dev` or `npx convex deploy`?"
	);

	it('retries a transient failure', async () => {
		const waits: number[] = [];
		let calls = 0;
		const recorded = await reportFolderRename({
			record: async () => {
				if (++calls < 3) throw new Error('fetch failed');
			},
			isUnsupported: () => false,
			sleep: async (ms) => void waits.push(ms),
		});

		expect(recorded).toBe(true);
		expect(waits).toEqual([500, 2_000]);
	});

	it('throws once its retries are spent', async () => {
		let calls = 0;
		await expect(
			reportFolderRename({
				record: async () => {
					calls++;
					throw new Error('503 Service Unavailable');
				},
				isUnsupported: (err) => isMissingFunction(err, fn.recordRemoteFolderRename),
				sleep: async () => {},
			})
		).rejects.toThrow('503');
		expect(calls).toBe(3);
	});

	it('settles as before on a backend that has no such mutation', async () => {
		let calls = 0;
		const recorded = await reportFolderRename({
			record: async () => {
				calls++;
				throw missing;
			},
			isUnsupported: (err) => isMissingFunction(err, fn.recordRemoteFolderRename),
			sleep: async () => {},
		});

		expect(recorded).toBe(false);
		expect(calls).toBe(1);
	});

	it('tells a missing function from every other failure', () => {
		const ref = fn.recordRemoteFolderRename;
		expect(isMissingFunction(missing, ref)).toBe(true);
		expect(
			isMissingFunction(
				new Error(
					"Could not find function for 'mail/external/remoteFolderRename.js:recordRemoteFolderRename'"
				),
				ref
			)
		).toBe(true);
		expect(isMissingFunction(missing, fn.listQueuedFolderRenames)).toBe(false);
		expect(isMissingFunction(new Error('fetch failed'), ref)).toBe(false);
		expect(isMissingFunction(new Error('503 Service Unavailable'), ref)).toBe(false);
		expect(isMissingFunction(undefined, ref)).toBe(false);
	});
});
