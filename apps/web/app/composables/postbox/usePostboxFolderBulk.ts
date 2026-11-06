/**
 * Whole-folder chores for the Postbox: "Mark all as read" and "Empty trash /
 * spam". The rail's context menus, the list header's folder menu, the bar at
 * the top of Trash and Spam, the Categories view's section headers, the
 * Bundled view's bundle rows and the command palette all call these, so the
 * entry points cannot drift apart.
 *
 * Marking read covers a folder, a label, one smart-inbox category of a folder,
 * a bundle's messages, or one system folder of several mailboxes (All inboxes
 * and the unified folders). It walks the server one batch at a time and keeps
 * every id it flipped, because Undo has to put back exactly those and no
 * others. Emptying is for one Trash or Spam folder only, and asks first: the
 * request parks the folder in shared state, and the one dialog PostboxLayout
 * renders (PostboxEmptyFolderDialog) confirms it with the count.
 */

import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { optimisticSetFlags } from '~/lib/mailOptimistic/mailUpdaters';
import type { MailCategory } from '~/utils/mailCategory';
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

/** What one "Mark all as read" covers. */
export type PostboxMarkReadTarget =
	| { kind: 'folder'; folder: PostboxBulkFolder }
	| { kind: 'label'; mailboxId: Id<'mailboxes'>; labelId: Id<'mailLabels'> }
	| { kind: 'category'; folderId: Id<'mailFolders'>; category: MailCategory }
	/** A bundle: the unread messages it holds, which the row already has. */
	| { kind: 'messages'; messageIds: readonly Id<'mailMessages'>[] }
	/**
	 * One folder per mailbox (All inboxes, a unified folder), each marked
	 * through its own mailbox's access check, optionally only one category.
	 */
	| { kind: 'folders'; folderIds: readonly Id<'mailFolders'>[]; category?: MailCategory | null };

function targetKey(target: PostboxMarkReadTarget): string {
	switch (target.kind) {
		case 'folder':
			return target.folder._id;
		case 'label':
			return `label:${target.labelId}`;
		case 'category':
			return `category:${target.folderId}:${target.category}`;
		case 'messages':
			return `messages:${[...target.messageIds].sort().join(',')}`;
		case 'folders':
			return `folders:${[...target.folderIds].sort().join(',')}:${target.category ?? ''}`;
	}
}

/** One server batch: the ids it flipped and where the next batch starts. */
type MarkStep<C> = (
	cursor: C | null
) => Promise<{ markedIds: Id<'mailMessages'>[]; next: C | null } | null>;

/**
 * Run batches until the server reports the end or a batch fails, collecting
 * every flipped id into `marked`. False when it stopped on a failure.
 */
async function walkBatches<C>(step: MarkStep<C>, marked: Id<'mailMessages'>[]): Promise<boolean> {
	let cursor: C | null = null;
	for (;;) {
		const batch = await step(cursor);
		if (!batch) return false;
		marked.push(...batch.markedIds);
		if (batch.next === null) return true;
		cursor = batch.next;
	}
}

interface PendingEmpty {
	folderId: Id<'mailFolders'>;
	role: EmptyableFolderRole;
	count: number;
}

// One walk per target at a time: a second click while the first is still
// paging would race it for the same rows and split the Undo in two.
const markingTargets = new Set<string>();

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
	const markCategoryBatch = useBackendOperation(api.mail.folderBulk.markCategoryRead, {
		label: () => t('shared.postbox.usePostboxFolderBulk.markAllReadOperation'),
	});
	const markLabelBatch = useBackendOperation(api.mail.folderBulk.markLabelRead, {
		label: () => t('shared.postbox.usePostboxFolderBulk.markAllReadOperation'),
	});

	function canEmpty(folder: PostboxBulkFolder | null | undefined): boolean {
		return (
			!!folder && isEmptyableRole(folder.role) && folder.totalCount > 0 && myRole.value === 'owner'
		);
	}

	type UidCursor = { ceilingUid: number; afterUid: number };

	function folderStep(
		folderId: Id<'mailFolders'>,
		category: MailCategory | null | undefined
	): MarkStep<UidCursor> {
		return async (cursor) => {
			const batch = category
				? await markCategoryBatch.run({ folderId, category, ...cursor })
				: await markBatch.run({ folderId, ...cursor });
			if (!batch.ok) return null;
			const { markedIds, ceilingUid, afterUid } = batch.result;
			return { markedIds, next: afterUid === null ? null : { ceilingUid, afterUid } };
		};
	}

	type LabelCursor = { ceilingTime: number; afterTime: number; afterId: Id<'mailMessages'> };

	function labelStep(mailboxId: Id<'mailboxes'>, labelId: Id<'mailLabels'>): MarkStep<LabelCursor> {
		return async (cursor) => {
			const batch = await markLabelBatch.run({ mailboxId, labelId, ...cursor });
			if (!batch.ok) return null;
			const { markedIds, ceilingTime, afterTime, afterId } = batch.result;
			return {
				markedIds,
				next: afterTime === null || afterId === null ? null : { ceilingTime, afterTime, afterId },
			};
		};
	}

	async function runTarget(
		target: PostboxMarkReadTarget,
		marked: Id<'mailMessages'>[]
	): Promise<void> {
		switch (target.kind) {
			case 'folder':
				await walkBatches(folderStep(target.folder._id as Id<'mailFolders'>, null), marked);
				return;
			case 'category':
				await walkBatches(folderStep(target.folderId, target.category), marked);
				return;
			case 'label':
				await walkBatches(labelStep(target.mailboxId, target.labelId), marked);
				return;
			case 'messages':
				for (const messageIds of chunkForMove(target.messageIds)) {
					const result = await setFlags.run({ messageIds, seen: true });
					if (!result.ok) return;
					// Only what this call flipped: a message another client read
					// after the row was drawn stays read on Undo.
					marked.push(...result.result.seenChangedIds);
				}
				return;
			case 'folders':
				// One mailbox refusing (a membership that just ended) does not stop
				// the others; the failed batch has already said so.
				for (const folderId of target.folderIds) {
					await walkBatches(folderStep(folderId, target.category), marked);
				}
				return;
		}
	}

	/** Mark everything the target covers read, with one Undo for all of it. */
	async function markRead(target: PostboxMarkReadTarget) {
		if (target.kind === 'folder' && !canMarkFolderRead(target.folder)) return;
		if (target.kind === 'messages' && target.messageIds.length === 0) return;
		if (target.kind === 'folders' && target.folderIds.length === 0) return;
		const key = targetKey(target);
		if (markingTargets.has(key)) return;
		markingTargets.add(key);
		const marked: Id<'mailMessages'>[] = [];
		try {
			await runTarget(target, marked);
		} finally {
			markingTargets.delete(key);
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

	function markAllRead(folder: PostboxBulkFolder) {
		return markRead({ kind: 'folder', folder });
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
		markRead,
		requestEmpty,
		cancelEmpty,
		confirmEmpty,
	};
}
