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
 * inbox, which is what deleting a folder does in Owlat too. The new name of a
 * renamed folder is handed back to the backend, which rewrites the ops still
 * naming the old one. The rename op is done only once the backend has that
 * name: until then it fails and its retry reports again, and a worker that
 * restarts first reports every queued rename the provider already shows
 * (`recoverRenames`), before any op still naming the old folder runs.
 *
 * ImapFlow resolves `false` rather than rejecting when the server refuses a
 * MOVE, COPY, STORE or EXPUNGE (imapCommandErrors.ts), so every result is read: a
 * refusal fails the op, which is retried, and never counts as done.
 */

import type { FolderRole } from './folders.js';
import { isMissingMailbox, refusedCommand } from './imapCommandErrors.js';
import type {
	RemoteFolderMap,
	RemoteFolderRef,
	RemoteOp,
	RemoteOpOutcome,
	RemoteOpsClient,
	ReplayHooks,
} from './remoteOpTypes.js';

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
		private readonly folders: RemoteFolderMap,
		private readonly hooks: ReplayHooks = {}
	) {}

	async apply(op: RemoteOp): Promise<Exclude<RemoteOpOutcome, 'failed'>> {
		if (op.kind === 'renameFolder') return await this.renameFolder(op);
		const source = this.existingPath(op.source);
		if (op.kind === 'deleteFolder') return await this.deleteFolder(source);

		const id = canonicalMessageId(op.rfc822MessageId ?? '');
		if (!id) return 'not_found';

		if (op.kind === 'delete') {
			if (!source || this.folders.allMail.has(source)) return 'not_found';
			return (await this.withMessage(source, id, (uids) => this.expunge(uids)))
				? 'done'
				: 'not_found';
		}

		if (op.kind === 'flags') {
			const add = flagNames(op.flags, true);
			const remove = flagNames(op.flags, false);
			if (add.length === 0 && remove.length === 0) return 'done';
			const found = await this.inAnyFolder(source, null, id, async (uids) => {
				// A flag the folder does not keep is never sent: retrying cannot change that.
				const kept = add.filter((flag) => this.keepsFlag(flag));
				if (kept.length < add.length) {
					const lost = add.filter((flag) => !kept.includes(flag)).join(' ');
					this.hooks.skipped?.(op, `the folder's PERMANENTFLAGS do not allow ${lost}`);
				}
				if (kept.length > 0) {
					await this.accepted('STORE', () => this.client.messageFlagsAdd(uids, kept, UID));
				}
				if (remove.length > 0) {
					await this.accepted('STORE', () => this.client.messageFlagsRemove(uids, remove, UID));
				}
			});
			return found ? 'done' : 'not_found';
		}

		if (!op.target) return 'not_found';
		const target = await this.targetPath(op.target);
		const found = await this.inAnyFolder(source, target, id, async (uids, path) => {
			if (path === target) return;
			if (this.folders.allMail.has(path)) {
				await this.accepted('COPY', () => this.client.messageCopy(uids, target, UID));
			} else {
				await this.move(uids, target);
			}
		});
		return found ? 'done' : 'not_found';
	}

	/**
	 * Before the first replay after a restart: a rename this worker carried out
	 * but could not report is still named by the old name in the backend, and
	 * an op for that name would find no folder. Report each queued rename the
	 * provider already shows as done — the old name gone, the new one there —
	 * and leave the rest to their own turn in the queue. A failed report
	 * throws, so nothing runs against the old name; false when a folder could
	 * not be counted, and the caller then replays nothing until a later drain
	 * has checked every queued rename.
	 */
	async recoverRenames(ops: RemoteOp[]): Promise<boolean> {
		let complete = true;
		for (const op of ops) {
			const rename = this.renameOf(op);
			if (!rename || rename.to === rename.path) continue;
			let renamed: boolean;
			try {
				renamed =
					(await this.messageCount(rename.path)) === null &&
					(await this.messageCount(rename.to)) !== null;
			} catch (err) {
				if (!this.client.usable) throw err;
				complete = false;
				continue;
			}
			if (renamed) await this.recordRename(op, rename);
		}
		return complete;
	}

	private async renameFolder(op: RemoteOp): Promise<'done' | 'not_found'> {
		const rename = this.renameOf(op);
		if (!rename) return 'not_found';
		const { path, to } = rename;
		if ((await this.messageCount(path)) === null) {
			// Gone under its old name but there under the new one: this op renamed
			// it before a restart cut it off from settling.
			if (to === path || (await this.messageCount(to)) === null) return 'not_found';
		} else if (to !== path) {
			await this.accepted('RENAME', () => this.client.mailboxRename(path, to));
		}
		await this.recordRename(op, rename);
		return 'done';
	}

	/**
	 * What a rename op does: `path` is where the folder is now (after any rename
	 * this worker already made), `to` its new name in the same parent.
	 */
	private renameOf(op: RemoteOp): { path: string; to: string; delimiter: string } | null {
		const path = op.kind === 'renameFolder' ? this.existingPath(op.source) : null;
		const name = op.target && 'path' in op.target ? op.target.path[0] : undefined;
		if (!path || !name || this.isSystemFolder(path)) return null;
		const delimiter = this.client.namespace?.delimiter || '/';
		const to = [...path.split(delimiter).slice(0, -1), name].join(delimiter);
		return { path, to, delimiter };
	}

	/**
	 * Remember the rename and report it to the backend, which still names the
	 * folder as the op does. That is the old name also when this worker already
	 * renamed the folder and `path` is the new one: a retry after a report that
	 * failed.
	 */
	private async recordRename(
		op: RemoteOp,
		{ path, to, delimiter }: { path: string; to: string; delimiter: string }
	): Promise<void> {
		if (to !== path) this.folders.renamed?.set(path, to);
		const from = 'remote' in op.source ? op.source.remote : path;
		if (from !== to) await this.hooks.renamed?.(op, { from, to, delimiter });
	}

	private async deleteFolder(path: string | null): Promise<'done' | 'not_found'> {
		if (!path || this.isSystemFolder(path)) return 'not_found';
		const count = await this.messageCount(path);
		if (count === null) return 'not_found';
		if (count > 0) {
			const inbox = this.folders.byRole.get('inbox') ?? 'INBOX';
			const lock = await this.client.getMailboxLock(path);
			try {
				await this.move('1:*', inbox);
			} finally {
				lock.release();
			}
			// Mail that arrived since, or a move the server carried out only in
			// part, would go with the folder: delete it only once it is empty.
			const left = await this.messageCount(path);
			if (left === null) return 'done';
			if (left > 0) throw new Error(`DELETE withheld: the folder still holds ${left} messages`);
		}
		await this.accepted('DELETE', () => this.client.mailboxDelete(path));
		return 'done';
	}

	/**
	 * Run one action command and fail on a refusal: ImapFlow resolves `false`
	 * for a command the server refused and nothing for one it could not send.
	 */
	private async accepted(command: string, run: () => Promise<unknown>): Promise<void> {
		this.hooks.takeRefusal?.(); // a warning logged before this command is not its refusal
		const result = await run();
		if (result === false || result === undefined) {
			throw refusedCommand(command, this.hooks.takeRefusal?.());
		}
	}

	/**
	 * MOVE. A server without it gets a COPY, and the originals are expunged only
	 * once the COPY succeeded; ImapFlow's own fallback expunges them either way.
	 */
	private async move(uids: string, target: string): Promise<void> {
		const c = this.client;
		const rev2 =
			c.enabled.has('IMAP4REV2') ||
			(c.capabilities.has('IMAP4rev2') && !c.capabilities.has('IMAP4rev1'));
		if (c.capabilities.has('MOVE') || rev2) {
			await this.accepted('MOVE', () => c.messageMove(uids, target, UID));
			return;
		}
		await this.accepted('COPY', () => c.messageCopy(uids, target, UID));
		await this.expunge(uids);
	}

	/**
	 * STORE \Deleted, then EXPUNGE. ImapFlow's messageDelete ignores a refused
	 * STORE and reports the EXPUNGE alone, which then removes nothing.
	 */
	private async expunge(uids: string): Promise<void> {
		if (!this.keepsFlag('\\Deleted')) {
			throw new Error("STORE failed: the folder's PERMANENTFLAGS do not allow \\Deleted");
		}
		await this.accepted('STORE', () => this.client.messageFlagsAdd(uids, ['\\Deleted'], UID));
		await this.accepted('EXPUNGE', () => this.client.messageDelete(uids, UID));
	}

	/** Whether the selected folder keeps `flag`: ImapFlow drops one it does not, unsent. */
	private keepsFlag(flag: string): boolean {
		const permanent = this.client.mailbox ? this.client.mailbox.permanentFlags : undefined;
		return !permanent || permanent.has('\\*') || permanent.has(flag);
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
