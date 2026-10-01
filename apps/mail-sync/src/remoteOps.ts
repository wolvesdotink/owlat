/**
 * Replays the local → remote write-back queue on the provider.
 *
 * Owlat records every move, flag change and permanent delete a member makes in
 * an external mailbox (`apps/api/convex/mail/external/remoteOps.ts`); this
 * module applies them over the account's IMAP connection so the provider's
 * mailbox, and every other client reading it, shows the same state.
 *
 * An op names its message by Message-ID and the remote folder it should be in.
 * The worker SEARCHes that folder for the header, confirms each hit against its
 * envelope (a header search is a substring match), and acts on the UIDs found.
 * When the message is not where the op says — it was filed before this queue
 * existed, or moved on the provider meanwhile — moves and flag changes look in
 * the other synced folders too. A delete never does: it only removes the copy
 * in the folder the member deleted it from.
 *
 * Gmail's "All Mail" holds every message under every label, and expunging from
 * it deletes the message everywhere, so a move out of it is a COPY (adding the
 * label) and a delete there is never issued.
 *
 * Two ops act on a folder rather than a message: renaming a mirrored folder
 * (its own name only, so it stays where it sits in the provider's tree) and
 * deleting one — after moving what the provider still holds in it to the
 * inbox, which is what deleting a folder does in Owlat too.
 */

import type { FolderRole } from './folders.js';

/** A system folder by role, an Owlat folder by its path of names, or a mapped folder by remote name. */
export type RemoteFolderRef = { role: FolderRole } | { path: string[] } | { remote: string };

/** One queued write-back, as `listDueRemoteOps` returns it. */
export interface RemoteOp {
	opId: string;
	kind: 'move' | 'flags' | 'delete' | 'renameFolder' | 'deleteFolder';
	/** Absent on the two folder kinds. */
	rfc822MessageId?: string;
	source: RemoteFolderRef;
	target?: RemoteFolderRef;
	flags?: { seen?: boolean; flagged?: boolean; answered?: boolean };
	attempts: number;
}

export type RemoteOpOutcome = 'done' | 'not_found' | 'failed';

export interface RemoteOpResult {
	opId: string;
	outcome: RemoteOpOutcome;
	error?: string;
}

/** The slice of ImapFlow the replay uses, narrowed so tests can fake it. */
export interface RemoteOpsClient {
	readonly usable: boolean;
	/** The personal namespace (NAMESPACE), which user-folder paths live under. */
	readonly namespace?: { prefix?: string | null; delimiter?: string | null };
	getMailboxLock(path: string): Promise<{ release(): void }>;
	search(
		query: { header: Record<string, string> },
		options: { uid: true }
	): Promise<number[] | false | undefined>;
	fetch(
		range: string,
		query: { uid: true; envelope: true },
		options: { uid: true }
	): AsyncIterable<{ uid: number; envelope?: { messageId?: string } }>;
	messageMove(range: string, destination: string, options: { uid: true }): Promise<unknown>;
	messageCopy(range: string, destination: string, options: { uid: true }): Promise<unknown>;
	messageFlagsAdd(range: string, flags: string[], options: { uid: true }): Promise<unknown>;
	messageFlagsRemove(range: string, flags: string[], options: { uid: true }): Promise<unknown>;
	messageDelete(range: string, options: { uid: true }): Promise<unknown>;
	mailboxCreate(path: string[]): Promise<{ path: string }>;
	mailboxRename(path: string, newPath: string): Promise<unknown>;
	mailboxDelete(path: string): Promise<unknown>;
	/** ImapFlow resolves `false`, not a rejection, when the server refuses a STATUS of a folder it lists. */
	status(path: string, query: { messages: true }): Promise<{ messages?: number } | false>;
}

/** What folder discovery learned about the account, shared with the replay. */
export interface RemoteFolderMap {
	/** Remote path of each system folder the server has. */
	byRole: Map<FolderRole, string>;
	/** Paths that list every message regardless of label (Gmail's All Mail). */
	allMail: Set<string>;
	/**
	 * Folders this worker renamed, old path → new. An op queued before the
	 * backend learned the new name still says the old one.
	 */
	renamed?: Map<string, string>;
}

/** Remote folders are created under these names when a server has no such role. */
const DEFAULT_ROLE_NAMES: Record<FolderRole, string> = {
	inbox: 'INBOX',
	sent: 'Sent',
	drafts: 'Drafts',
	trash: 'Trash',
	spam: 'Junk',
	archive: 'Archive',
};

const FLAG_NAMES = { seen: '\\Seen', flagged: '\\Flagged', answered: '\\Answered' } as const;

/** Gmail's All Mail, by SPECIAL-USE or by the names its two locales use. */
export function isAllMailFolder(specialUse: string | undefined, path: string): boolean {
	if (specialUse === '\\All') return true;
	const p = path.toLowerCase();
	return p === '[gmail]/all mail' || p === '[google mail]/all mail';
}

/**
 * The server said the mailbox does not exist: ImapFlow's LIST check after a
 * refused SELECT (`mailboxMissing`) or STATUS (`NotFound`), or the server's own
 * NONEXISTENT response code. Anything else — UNAVAILABLE, throttling, a
 * permission refusal — says nothing about whether the folder is there.
 */
export function isMissingMailbox(err: unknown): boolean {
	if (!err || typeof err !== 'object') return false;
	const e = err as { mailboxMissing?: unknown; code?: unknown; serverResponseCode?: unknown };
	return (
		e.mailboxMissing === true ||
		e.code === 'NotFound' ||
		(typeof e.serverResponseCode === 'string' &&
			e.serverResponseCode.toUpperCase() === 'NONEXISTENT')
	);
}

/**
 * What to record as a failed op's error. ImapFlow's message for a refused
 * command is only "Command failed"; the server's status, response code and
 * text carry the reason.
 */
export function describeRemoteOpError(err: unknown): string {
	if (!(err instanceof Error)) return String(err);
	const e = err as Error & {
		code?: unknown;
		responseStatus?: unknown;
		serverResponseCode?: unknown;
		responseText?: unknown;
	};
	const detail = [
		e.responseStatus,
		typeof e.serverResponseCode === 'string' ? `[${e.serverResponseCode}]` : undefined,
		e.responseText,
	].filter((part): part is string => typeof part === 'string' && part.length > 0);
	let text = err.message;
	if (typeof e.code === 'string' && !text.includes(e.code)) text += ` (${e.code})`;
	return detail.length > 0 ? `${text}: ${detail.join(' ')}` : text;
}

function canonicalMessageId(raw: string): string {
	return raw.replace(/[<>]/g, '').trim();
}

/**
 * Applies ops against one connection. Holds the paths of user folders it has
 * already created, so a bulk move into a new folder issues one CREATE.
 */
export class RemoteOpReplayer {
	private readonly created = new Map<string, string>();

	constructor(
		private readonly client: RemoteOpsClient,
		private readonly folders: RemoteFolderMap
	) {}

	async apply(op: RemoteOp): Promise<Exclude<RemoteOpOutcome, 'failed'>> {
		const source = this.existingPath(op.source);
		if (op.kind === 'renameFolder') return await this.renameFolder(source, op.target);
		if (op.kind === 'deleteFolder') return await this.deleteFolder(source);

		const id = canonicalMessageId(op.rfc822MessageId ?? '');
		if (!id) return 'not_found';

		if (op.kind === 'delete') {
			if (!source || this.folders.allMail.has(source)) return 'not_found';
			return (await this.withMessage(source, id, (uids) => this.client.messageDelete(uids, UID)))
				? 'done'
				: 'not_found';
		}

		if (op.kind === 'flags') {
			const add = flagNames(op.flags, true);
			const remove = flagNames(op.flags, false);
			if (add.length === 0 && remove.length === 0) return 'done';
			const found = await this.inAnyFolder(source, null, id, async (uids) => {
				if (add.length > 0) await this.client.messageFlagsAdd(uids, add, UID);
				if (remove.length > 0) await this.client.messageFlagsRemove(uids, remove, UID);
			});
			return found ? 'done' : 'not_found';
		}

		if (!op.target) return 'not_found';
		const target = await this.targetPath(op.target);
		const found = await this.inAnyFolder(source, target, id, async (uids, path) => {
			if (path === target) return;
			if (this.folders.allMail.has(path)) await this.client.messageCopy(uids, target, UID);
			else await this.client.messageMove(uids, target, UID);
		});
		return found ? 'done' : 'not_found';
	}

	private async renameFolder(
		path: string | null,
		target: RemoteFolderRef | undefined
	): Promise<'done' | 'not_found'> {
		const name = target && 'path' in target ? target.path[0] : undefined;
		if (!path || !name || this.isSystemFolder(path)) return 'not_found';
		if ((await this.messageCount(path)) === null) return 'not_found';
		const delimiter = this.client.namespace?.delimiter || '/';
		const parent = path.split(delimiter).slice(0, -1);
		const renamed = [...parent, name].join(delimiter);
		if (renamed !== path) {
			await this.client.mailboxRename(path, renamed);
			this.folders.renamed?.set(path, renamed);
		}
		return 'done';
	}

	private async deleteFolder(path: string | null): Promise<'done' | 'not_found'> {
		if (!path || this.isSystemFolder(path)) return 'not_found';
		const count = await this.messageCount(path);
		if (count === null) return 'not_found';
		if (count > 0) {
			const inbox = this.folders.byRole.get('inbox') ?? 'INBOX';
			const lock = await this.client.getMailboxLock(path);
			try {
				await this.client.messageMove('1:*', inbox, UID);
			} finally {
				lock.release();
			}
		}
		await this.client.mailboxDelete(path);
		return 'done';
	}

	/** A remote name after any renames this worker made to it. */
	private currentName(name: string): string {
		const seen = new Set<string>();
		let current = name;
		while (this.folders.renamed?.has(current) && !seen.has(current)) {
			seen.add(current);
			current = this.folders.renamed.get(current)!;
		}
		return current;
	}

	/** A system folder, or Gmail's All Mail: never renamed or deleted from here. */
	private isSystemFolder(path: string): boolean {
		return (
			path.toUpperCase() === 'INBOX' ||
			this.folders.allMail.has(path) ||
			[...this.folders.byRole.values()].includes(path)
		);
	}

	/**
	 * How many messages a folder holds, or null when the provider says it has
	 * no such folder. Any other failure throws, so the op is retried rather
	 * than retired — or, for a delete, run against a folder whose contents
	 * were never counted.
	 */
	private async messageCount(path: string): Promise<number | null> {
		let status: { messages?: number } | false;
		try {
			status = await this.client.status(path, { messages: true });
		} catch (err) {
			if (this.client.usable && isMissingMailbox(err)) return null;
			throw err;
		}
		if (!status || typeof status.messages !== 'number') {
			throw new Error('STATUS failed: the server returned no message count');
		}
		return status.messages;
	}

	/**
	 * Run `action` in the first folder holding the message: the op's own folder
	 * first, then the other synced folders. A move never looks in Sent or
	 * Drafts, where taking the message out would lose the provider's record of
	 * it, and never in its own target, where there is nothing left to do.
	 */
	private async inAnyFolder(
		source: string | null,
		target: string | null,
		id: string,
		action: (uids: string, path: string) => Promise<unknown>
	): Promise<boolean> {
		const candidates: string[] = source ? [source] : [];
		for (const [role, path] of this.folders.byRole) {
			if (candidates.includes(path) || path === target) continue;
			if (target !== null && (role === 'sent' || role === 'drafts')) continue;
			candidates.push(path);
		}
		let unreadable: unknown;
		for (const path of candidates) {
			const found = await this.withMessage(
				path,
				id,
				(uids) => action(uids, path),
				(err) => (unreadable ??= err)
			);
			if (found) return true;
		}
		// Absent from every folder that could be read; one that could not may still hold it.
		if (unreadable !== undefined) throw unreadable;
		return false;
	}

	/**
	 * Select `path`, find the message, and run `action` on its UIDs. False when
	 * the message, or the folder itself, is confirmed absent. A folder the
	 * server would not select or search for any other reason throws, so the op
	 * is retried — or, given `unreadable`, is reported there and passed over,
	 * for a caller that looks in other folders first.
	 */
	private async withMessage(
		path: string,
		id: string,
		action: (uids: string) => Promise<unknown>,
		unreadable?: (err: unknown) => void
	): Promise<boolean> {
		const passOver = (err: unknown): false => {
			if (!unreadable || !this.client.usable) throw err;
			unreadable(err);
			return false;
		};
		let lock: { release(): void };
		try {
			lock = await this.client.getMailboxLock(path);
		} catch (err) {
			// A folder that does not exist (a user folder never mirrored, or one
			// deleted on the provider) simply does not hold the message.
			if (this.client.usable && isMissingMailbox(err)) return false;
			return passOver(err);
		}
		try {
			let uids: number[];
			try {
				uids = await this.findUids(id);
			} catch (err) {
				return passOver(err);
			}
			if (uids.length === 0) return false;
			await action(uids.join(','));
			return true;
		} finally {
			lock.release();
		}
	}

	private async findUids(id: string): Promise<number[]> {
		const hits = await this.client.search({ header: { 'message-id': id } }, UID);
		// ImapFlow resolves `false` for a SEARCH the server refused: not a miss.
		if (hits === false) throw new Error('SEARCH failed');
		if (!hits || hits.length === 0) return [];
		const confirmed: number[] = [];
		for await (const msg of this.client.fetch(hits.join(','), { uid: true, envelope: true }, UID)) {
			const found = msg.envelope?.messageId;
			if (found && canonicalMessageId(found) === id) confirmed.push(Number(msg.uid));
		}
		return confirmed;
	}

	/** The remote path of a folder that should already exist, or null. */
	private existingPath(ref: RemoteFolderRef): string | null {
		if ('remote' in ref) return this.currentName(ref.remote);
		if ('role' in ref) return this.folders.byRole.get(ref.role) ?? null;
		return this.created.get(pathKey(ref.path)) ?? this.userFolderPath(ref.path);
	}

	/**
	 * A user folder's full remote name: segments joined with the server's
	 * delimiter under its personal namespace — the name ImapFlow itself gives
	 * the folder on CREATE, so a folder made earlier is found by it.
	 */
	private userFolderPath(segments: string[]): string {
		const ns = this.client.namespace;
		const path = segments.join(ns?.delimiter || '/');
		if (path.toUpperCase() === 'INBOX') return 'INBOX';
		return ns?.prefix && !path.startsWith(ns.prefix) ? ns.prefix + path : path;
	}

	/** The remote path to move into, creating the folder when the server lacks it. */
	private async targetPath(ref: RemoteFolderRef): Promise<string> {
		if ('remote' in ref) return this.currentName(ref.remote);
		if ('role' in ref) {
			const known = this.folders.byRole.get(ref.role);
			if (known) return known;
			const { path } = await this.client.mailboxCreate([DEFAULT_ROLE_NAMES[ref.role]]);
			this.folders.byRole.set(ref.role, path);
			return path;
		}
		const key = pathKey(ref.path);
		const cached = this.created.get(key);
		if (cached) return cached;
		// CREATE of an existing folder answers ALREADYEXISTS, which ImapFlow
		// reports as `created: false` with the normalized path, so this is also
		// how an existing folder's full name (namespace prefix, delimiter) is read.
		const { path } = await this.client.mailboxCreate(ref.path);
		this.created.set(key, path);
		return path;
	}
}

const UID = { uid: true } as const;

function pathKey(path: string[]): string {
	return path.join('\u0000');
}

function flagNames(flags: RemoteOp['flags'], value: boolean): string[] {
	if (!flags) return [];
	return (Object.keys(FLAG_NAMES) as Array<keyof typeof FLAG_NAMES>)
		.filter((key) => flags[key] === value)
		.map((key) => FLAG_NAMES[key]);
}

export interface DrainDeps {
	listDue(): Promise<RemoteOp[]>;
	settle(results: RemoteOpResult[]): Promise<void>;
	replayer: RemoteOpReplayer;
	client: Pick<RemoteOpsClient, 'usable'>;
	isStopped(): boolean;
	onError(op: RemoteOp, err: unknown): void;
}

/**
 * Apply every due op, a page at a time, until none is left. A failed op is
 * settled as `failed` (the backend backs it off, so it is not listed again in
 * this drain); a lost connection ends the drain after settling what was done.
 */
export async function drainRemoteOps(deps: DrainDeps): Promise<void> {
	for (;;) {
		if (deps.isStopped()) return;
		const ops = await deps.listDue();
		if (ops.length === 0) return;
		const results: RemoteOpResult[] = [];
		let connectionLost = false;
		for (const op of ops) {
			if (deps.isStopped() || connectionLost) break;
			try {
				results.push({ opId: op.opId, outcome: await deps.replayer.apply(op) });
			} catch (err) {
				deps.onError(op, err);
				if (!deps.client.usable) {
					// Not the op's fault — leave it untouched for the reconnect.
					connectionLost = true;
					break;
				}
				results.push({ opId: op.opId, outcome: 'failed', error: describeRemoteOpError(err) });
			}
		}
		if (results.length > 0) await deps.settle(results);
		if (connectionLost || results.length < ops.length) return;
	}
}
