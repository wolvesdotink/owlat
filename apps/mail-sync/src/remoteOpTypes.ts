/**
 * The shapes the write-back replay (remoteOps.ts) works with: the queued op as
 * the backend hands it out, what the replay settles it as, the slice of
 * ImapFlow it drives, and what it reports back to the connection running it.
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

/** What MOVE and COPY resolve: the COPYUID map, or `false` / nothing when refused or never sent. */
type Copied = object | false | undefined;

/** The slice of ImapFlow the replay uses, narrowed so tests can fake it. */
export interface RemoteOpsClient {
	readonly usable: boolean;
	/** The personal namespace (NAMESPACE), which user-folder paths live under. */
	readonly namespace?: { prefix?: string | null; delimiter?: string | null };
	readonly capabilities: ReadonlyMap<string, unknown>;
	/** Extensions turned on with ENABLE. */
	readonly enabled: ReadonlySet<string>;
	/** The selected folder; its PERMANENTFLAGS are the flags it keeps (`\*`: any). */
	readonly mailbox: { permanentFlags?: ReadonlySet<string> | undefined } | false;
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
	messageMove(range: string, destination: string, options: { uid: true }): Promise<Copied>;
	messageCopy(range: string, destination: string, options: { uid: true }): Promise<Copied>;
	messageFlagsAdd(range: string, flags: string[], options: { uid: true }): Promise<boolean>;
	messageFlagsRemove(range: string, flags: string[], options: { uid: true }): Promise<boolean>;
	/** STORE \Deleted, whose result ImapFlow ignores, then EXPUNGE. */
	messageDelete(range: string, options: { uid: true }): Promise<boolean | undefined>;
	mailboxCreate(path: string[]): Promise<{ path: string }>;
	mailboxRename(path: string, newPath: string): Promise<object | undefined>;
	mailboxDelete(path: string): Promise<object | undefined>;
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
	 * backend learned the new name still says the old one. A cache: the
	 * backend rewrites those ops (`ReplayHooks.renamed`), and a rename it has
	 * not recorded yet is found again after a restart (`recoverRenames`).
	 */
	renamed?: Map<string, string>;
}

/** What the replay reports back to the connection running it. */
export interface ReplayHooks {
	/** The error ImapFlow logged for the command that just resolved `false` (imapCommandErrors.ts). */
	takeRefusal?(): unknown;
	/**
	 * A folder op renamed `from` to `to` at the provider, whose hierarchy
	 * delimiter is `delimiter`: record it with the backend. Throws when it could
	 * not, which fails the op so its retry reports again.
	 */
	renamed?(op: RemoteOp, rename: { from: string; to: string; delimiter: string }): Promise<void>;
	/** The op settles without the part of its change the provider cannot keep. */
	skipped?(op: RemoteOp, reason: string): void;
}

/** One page of an account's queued folder renames (`listQueuedFolderRenames`). */
export interface QueuedRenamesPage {
	page: RemoteOp[];
	isDone: boolean;
	continueCursor: string;
}
