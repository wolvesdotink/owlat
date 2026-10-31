/**
 * The two halves of a full sync cycle that talk to the provider about changes
 * rather than new mail: replaying members' write-backs on it (remoteOps.ts) and
 * mirroring the changes made there (remoteState.ts). Holds what both keep
 * across cycles and reconnects; the connection (connection.ts) decides when a
 * cycle runs and never runs two at once.
 */

import type { ImapFlow, ListResponse } from 'imapflow';
import type { ConvexClient } from './convex.js';
import { fn, isMissingFunction } from './convex.js';
import { isVirtualView, mapFolderRole, mirroredFolderPath, type FolderRole } from './folders.js';
import { CommandRefusals } from './imapCommandErrors.js';
import { isAllMailFolder, RemoteOpReplayer } from './remoteOps.js';
import type { QueuedRenamesPage } from './remoteOpTypes.js';
import { drainRemoteOps, recoverQueuedRenames, reportFolderRename } from './remoteOpsDrain.js';
import {
	LOCAL_PAGE,
	noPendingChanges,
	reconcile,
	type FolderView,
	type ModseqCursor,
} from './remoteState.js';
import { logger } from './logger.js';

/** A synced remote folder: a system role, or (full sync) a mirrored user folder by path. */
export interface SyncedFolder {
	remoteName: string;
	role?: FolderRole;
	path?: string[];
}

/** The provider's folders as the last discovery saw them (connection.ts). */
export interface FolderListing {
	folders: SyncedFolder[];
	// Every path the provider's last LIST returned, mirrored or not.
	listedPaths: string[];
	// Listed paths that are views onto mail filed elsewhere (never mirrored).
	virtualPaths: string[];
	// Gmail-style "All Mail" paths: the write-back copies out of them instead of moving.
	allMailPaths: Set<string>;
}

/**
 * Map the provider's folders: the six system roles always, and with full sync
 * every other selectable folder too, mirrored as a user folder. Runs on every
 * full cycle, so a folder created on the provider is picked up without a
 * reconnect (a message moved into an unknown folder would look deleted).
 */
export function listSyncedFolders(
	list: readonly ListResponse[],
	mode: 'full' | 'incoming',
	namespacePrefix: string | undefined
): FolderListing {
	const seen = new Set<FolderRole>();
	const mapped: SyncedFolder[] = [];
	const user: SyncedFolder[] = [];
	for (const entry of list) {
		const role = mapFolderRole(entry.specialUse, entry.path);
		if (role && !seen.has(role)) {
			seen.add(role);
			mapped.push({ remoteName: entry.path, role });
			continue;
		}
		if (mode !== 'full') continue;
		const path = mirroredFolderPath(entry, namespacePrefix);
		if (path) user.push({ remoteName: entry.path, path });
	}
	if (!mapped.some((m) => m.role === 'inbox')) {
		mapped.unshift({ remoteName: 'INBOX', role: 'inbox' });
	}
	return {
		folders: [...mapped, ...user],
		listedPaths: list.map((e) => e.path),
		virtualPaths: list.filter((e) => isVirtualView(e)).map((e) => e.path),
		allMailPaths: new Set(
			list.filter((e) => isAllMailFolder(e.specialUse, e.path)).map((e) => e.path)
		),
	};
}

/** Best-first order in which a moved message's new home is picked; user folders sit after the inbox. */
const ROLE_ORDER: ReadonlyArray<FolderRole | undefined> = [
	'inbox',
	undefined,
	'archive',
	'sent',
	'drafts',
	'spam',
	'trash',
];

/** A full reconcile at least this often, as a safety net for missed changes. */
const FULL_RECONCILE_INTERVAL_MS = 6 * 60 * 60 * 1000;

export class RemoteSync {
	// The error behind a command ImapFlow reports refused only by resolving `false`.
	readonly refusals = new CommandRefusals();
	// Folders the write-back renamed (remoteOps.ts), kept across drains.
	private readonly renamedFolders = new Map<string, string>();
	// Whether the queued renames were checked since this worker started (remoteOps.ts).
	private renamesRecovered = false;
	private lastFullReconcileAt = 0;
	// Per-folder views of the provider (remoteState.ts). Kept across reconnects,
	// so a change made while the connection was down still shows up as a change.
	private readonly views = new Map<string, FolderView>();
	// What a reconcile cut short had noticed but not yet settled (remoteState.ts).
	private pendingRemote = noPendingChanges();
	private readonly allMailCursor: ModseqCursor = { uidValidity: null, highestModseq: null };

	constructor(
		private readonly accountId: string,
		private readonly convex: ConvexClient
	) {}

	/**
	 * Whatever left a folder while the connection was down was never reported
	 * to us: every folder's first refresh compares its whole UID list.
	 */
	markAllCensusDue(): void {
		for (const view of this.views.values()) view.censusDue = true;
	}

	/** Something left this folder: its next refresh takes a census. */
	markCensusDue(path: string): void {
		const view = this.views.get(path);
		if (view) view.censusDue = true;
	}

	/** The account left full sync: nothing mirrored is tracked any more. */
	forgetViews(): void {
		this.views.clear();
		this.pendingRemote = noPendingChanges();
	}

	/**
	 * Replay on the provider the moves, flag changes and deletes members made in
	 * Owlat (remoteOps.ts). Only ever called inside a cycle; failures are logged
	 * and left for the next one.
	 */
	async drainQueue(
		client: ImapFlow,
		listing: FolderListing,
		isStopped: () => boolean
	): Promise<void> {
		const accountId = this.accountId;
		const byRole = new Map<FolderRole, string>();
		for (const f of listing.folders) if (f.role) byRole.set(f.role, f.remoteName);
		const replayer = new RemoteOpReplayer(
			client,
			{ byRole, allMail: listing.allMailPaths, renamed: this.renamedFolders },
			{
				takeRefusal: () => this.refusals.take(),
				renamed: async (op, { to, delimiter }) => {
					const recorded = await reportFolderRename({
						record: () =>
							this.convex.mutation(fn.recordRemoteFolderRename, {
								opId: op.opId,
								remoteName: to,
								delimiter,
							}),
						isUnsupported: (err) => isMissingFunction(err, fn.recordRemoteFolderRename),
					});
					if (!recorded) {
						logger.warn(
							{ accountId, opId: op.opId },
							'the backend cannot record folder renames yet; ops naming the old folder follow it until this worker restarts'
						);
					}
				},
				skipped: (op, reason) =>
					logger.warn(
						{ accountId, opId: op.opId, kind: op.kind, reason },
						'remote write-back skipped'
					),
			}
		);
		try {
			if (!this.renamesRecovered) {
				// A rename carried out but not recorded before this worker last stopped.
				this.renamesRecovered = await recoverQueuedRenames({
					listPage: (cursor) => this.queuedFolderRenames(cursor),
					replayer,
					isStopped,
				});
				if (!this.renamesRecovered) {
					// One could not be checked: an op naming its old folder would find no
					// folder and be retired. Nothing runs until a later drain checks it.
					logger.warn(
						{ accountId },
						'remote write-back held: a queued folder rename could not be checked'
					);
					return;
				}
			}
			await drainRemoteOps({
				listDue: () => this.convex.query(fn.listDueRemoteOps, { accountId }),
				settle: async (results) => {
					await this.convex.mutation(fn.settleRemoteOps, { results });
				},
				replayer,
				client,
				isStopped,
				onError: (op, err) =>
					logger.warn({ accountId, opId: op.opId, kind: op.kind, err }, 'remote write-back failed'),
			});
		} catch (err) {
			logger.warn({ accountId, err }, 'remote write-back drain failed');
		}
	}

	/** One page of the account's queued folder renames; null from a backend that predates the listing. */
	private async queuedFolderRenames(cursor: string | null): Promise<QueuedRenamesPage | null> {
		try {
			return await this.convex.query(fn.listQueuedFolderRenames, {
				accountId: this.accountId,
				cursor,
			});
		} catch (err) {
			if (isMissingFunction(err, fn.listQueuedFolderRenames)) return null;
			throw err;
		}
	}

	/** Mirror the provider's changes into Owlat (full sync only; remoteState.ts). */
	async reconcile(
		client: ImapFlow,
		listing: FolderListing,
		isAligned: boolean,
		isStopped: () => boolean
	): Promise<void> {
		const accountId = this.accountId;
		const { folders, allMailPaths } = listing;
		const tracked = [...folders]
			.filter((f) => !allMailPaths.has(f.remoteName))
			.sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role))
			.map((f) => f.remoteName);
		const allMail = folders.find((f) => allMailPaths.has(f.remoteName))?.remoteName;
		const { full, completed } = await reconcile({
			client,
			tracked,
			allMail: allMail ?? null,
			views: this.views,
			allMailCursor: this.allMailCursor,
			isAligned,
			forceFull: Date.now() - this.lastFullReconcileAt > FULL_RECONCILE_INTERVAL_MS,
			pending: this.pendingRemote,
			listLocal: (cursor) =>
				this.convex.query(fn.listLocalMessages, {
					accountId,
					paginationOpts: { numItems: LOCAL_PAGE, cursor },
				}),
			lookupLocal: (messageIds) =>
				this.convex.query(fn.lookupLocalMessages, { accountId, messageIds }),
			apply: async (observations) => {
				await this.convex.mutation(fn.applyRemoteObservations, { accountId, observations });
			},
			markAligned: async () => {
				await this.convex.mutation(fn.markFullSyncAligned, { accountId });
			},
			isStopped,
		});
		if (full) this.lastFullReconcileAt = Date.now();
		// Only after a completed pass: by then the mail of a folder the provider
		// renamed or deleted has followed it, and its empty local copy can go.
		if (completed) {
			await this.convex.mutation(fn.forgetRemoteFolders, {
				accountId,
				listed: [...new Set([...listing.listedPaths, ...folders.map((f) => f.remoteName)])],
				retired: listing.virtualPaths.filter((p) => !folders.some((f) => f.remoteName === p)),
			});
		}
	}
}
