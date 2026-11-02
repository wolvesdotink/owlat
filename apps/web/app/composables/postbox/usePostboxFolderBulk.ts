/**
 * Whole-folder chores for the Postbox: "Mark all as read" and "Empty trash /
 * spam". The rail's context menu, the list header's folder menu, the bar at the
 * top of Trash and Spam and the command palette all call these, so the four
 * entry points cannot drift apart.
 *
 * Marking read walks the folder one server batch at a time and keeps every id
 * it flipped, because Undo has to put back exactly those and no others. Emptying
 * asks first: the request parks the folder in shared state, and the one dialog
 * PostboxLayout renders (PostboxEmptyFolderDialog) confirms it with the count.
 */

import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { optimisticSetFlags } from '~/lib/mailOptimistic/mailUpdaters';
import { chunkForMove } from './usePostboxTriageUndo';

/** The fields of a `listFolders` row these actions read. */
export interface PostboxBulkFolder {
	_id: string;
	role?: string | null;
	unseenCount: number;
	totalCount: number;
}

/** The roles that have an "Empty now" (the server refuses every other folder). */
export type EmptyableFolderRole = 'trash' | 'spam';

export function isEmptyableRole(role: string | null | undefined): role is EmptyableFolderRole {
	return role === 'trash' || role === 'spam';
}

/** Drafts are unsent mail of your own; "read" means nothing there. */
export function canMarkFolderRead(folder: PostboxBulkFolder | null | undefined): boolean {
	return !!folder && folder.role !== 'drafts' && folder.unseenCount > 0;
}

/**
 * The folder row a list view stands for: a custom folder by id, a system
 * folder by role. Null for views that are not one folder (Snoozed, a label).
 */
export function findViewFolder<F extends PostboxBulkFolder>(
	folders: readonly F[],
	folderRole: string,
	folderId: string | undefined
): F | null {
	return (
		folders.find((folder) => (folderId ? folder._id === folderId : folder.role === folderRole)) ??
		null
	);
}

interface PendingEmpty {
	folderId: Id<'mailFolders'>;
	role: EmptyableFolderRole;
	count: number;
}

// One walk per folder at a time: a second click while the first is still
// paging would race it for the same rows and split the Undo in two.
const markingFolders = new Set<string>();

export function usePostboxFolderBulk(mailboxId: Ref<Id<'mailboxes'> | null>) {
	const { t } = useI18n();
	const { showToast } = useToast();
	const triageUndo = usePostboxTriageUndo();
	const pendingEmpty = useState<PendingEmpty | null>('postbox:folder-bulk:empty', () => null);

	// Emptying a team inbox's bin needs its owner role (the server says so too);
	// on a personal mailbox its own user is the owner.
	const { data: myRole } = useConvexQuery(api.mail.mailboxMembers.myRole, () =>
		mailboxId.value ? { mailboxId: mailboxId.value } : 'skip'
	);

	const markBatch = useBackendOperation(api.mail.folderBulk.markFolderRead, {
		label: () => t('shared.postbox.usePostboxFolderBulk.markAllReadOperation'),
	});
	const setFlags = useBackendOperation(api.mail.messageActions.setFlags, {
		label: () => t('shared.postbox.usePostboxBulkActions.setFlagsOperation'),
		optimisticUpdate: optimisticSetFlags,
	});
	const empty = useBackendOperation(api.mail.folderBulk.emptyFolder, {
		label: () => t('shared.postbox.usePostboxFolderBulk.emptyOperation'),
	});

	function canEmpty(folder: PostboxBulkFolder | null | undefined): boolean {
		return (
			!!folder && isEmptyableRole(folder.role) && folder.totalCount > 0 && myRole.value === 'owner'
		);
	}

	async function markAllRead(folder: PostboxBulkFolder) {
		if (!canMarkFolderRead(folder) || markingFolders.has(folder._id)) return;
		markingFolders.add(folder._id);
		const folderId = folder._id as Id<'mailFolders'>;
		const marked: Id<'mailMessages'>[] = [];
		try {
			let cursor: { ceilingUid: number; afterUid: number } | null = null;
			for (;;) {
				const batch = await markBatch.run({ folderId, ...(cursor ?? {}) });
				if (!batch.ok) break;
				marked.push(...batch.result.markedIds);
				if (batch.result.afterUid === null) break;
				cursor = { ceilingUid: batch.result.ceilingUid, afterUid: batch.result.afterUid };
			}
		} finally {
			markingFolders.delete(folder._id);
		}
		if (marked.length === 0) return;
		// A walk that stopped on an error still offers to put back what it did.
		triageUndo.register({
			label: t(
				'shared.postbox.usePostboxFolderBulk.markedAllRead',
				{ count: marked.length },
				marked.length
			),
			inverse: async () => {
				for (const messageIds of chunkForMove(marked)) {
					await setFlags.run({ messageIds, seen: false });
				}
			},
		});
	}

	function requestEmpty(folder: PostboxBulkFolder) {
		if (!canEmpty(folder) || !isEmptyableRole(folder.role)) return;
		pendingEmpty.value = {
			folderId: folder._id as Id<'mailFolders'>,
			role: folder.role,
			count: folder.totalCount,
		};
	}

	function cancelEmpty() {
		pendingEmpty.value = null;
	}

	async function confirmEmpty() {
		const pending = pendingEmpty.value;
		pendingEmpty.value = null;
		if (!pending) return;
		const result = await empty.run({ folderId: pending.folderId });
		if (!result.ok) return;
		showToast(t(`shared.postbox.usePostboxFolderBulk.emptied.${pending.role}`), 'success');
	}

	return {
		pendingEmpty,
		canEmpty,
		markAllRead,
		requestEmpty,
		cancelEmpty,
		confirmEmpty,
	};
}
