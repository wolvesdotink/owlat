/**
 * Deleting the conversation that is open in the reader FROM THE LIST — a row's
 * Delete (hover button, context menu, `#`, swipe), a drag onto Trash, the bulk
 * bar's Delete or Delete forever — takes the reader off it, the same way the
 * reader's own Delete does: the auto-advance setting picks the neighbour in the
 * list's visual order, and with no neighbour (or "Back to the list") the reader
 * closes. It happens when the delete is sent, not when the server answers, and
 * a delete that fails goes back to the message unless the person has moved on.
 *
 * The verbs live in two places that do not share an owner with the list that
 * knows what is open (the row verbs in `usePostboxRowTriage`, the bulk bar's in
 * `usePostboxBulkActions`), so a delete announces its ids through
 * {@link leaveDeletedOpenRow} and every mounted list checks them against its own
 * open row — the same module-scope broadcast `hidePostboxRowEverywhere` uses.
 */

import type { Id } from '@owlat/api/dataModel';
import { pickAdjacentMessageId, type PostboxAutoAdvanceMode } from '~/utils/postboxAutoAdvance';

/** Undo the leave for the ids whose delete failed (a no-op for the rest). */
type ReturnToDeletedOpenRow = (failedIds: readonly string[]) => void;

type OpenRowClaim = {
	/** The list renders the open row, so it knows its neighbours. */
	rendersOpenRow: boolean;
	leave: () => ReturnToDeletedOpenRow;
};
type OpenRowGuard = (deleted: ReadonlySet<string>) => OpenRowClaim | null;

const guards = new Set<OpenRowGuard>();

/**
 * Call before a delete of `ids` is sent (and before its rows are hidden, so the
 * neighbour comes from the order the person saw). Hand the returned function
 * the ids whose delete failed.
 *
 * Only one list acts: the one that renders the open row, else the first list
 * whose open row is among `ids` (a select-all delete can include an open
 * message that is not on screen); it then simply closes.
 */
export function leaveDeletedOpenRow(ids: readonly string[]): ReturnToDeletedOpenRow {
	if (ids.length === 0) return () => {};
	const deleted = new Set<string>(ids);
	let chosen: OpenRowClaim | null = null;
	for (const guard of guards) {
		const claim = guard(deleted);
		if (!claim) continue;
		if (claim.rendersOpenRow) {
			chosen = claim;
			break;
		}
		chosen ??= claim;
	}
	return chosen ? chosen.leave() : () => {};
}

/**
 * The list half: register this list's open row and how it leaves it.
 * `leave(left, target)` shows `target` instead of `left` (null closes) and may
 * return how to show `left` again after a failed delete.
 */
export function usePostboxDeletedOpenRowGuard(opts: {
	/** The list's rows in visual order (after optimistic hiding). */
	orderedIds: () => readonly string[];
	openId: () => string | null | undefined;
	autoAdvance: () => PostboxAutoAdvanceMode;
	leave: (left: string, target: string | null) => (() => void) | void;
}) {
	const guard: OpenRowGuard = (deleted) => {
		const open = opts.openId();
		if (!open || !deleted.has(open)) return null;
		const ordered = opts.orderedIds();
		return {
			rendersOpenRow: ordered.includes(open),
			leave: () => {
				// The rest of the same delete is leaving too: never advance onto it.
				const remaining = ordered.filter((id) => id === open || !deleted.has(id));
				const target = pickAdjacentMessageId(remaining, open, opts.autoAdvance());
				const back = opts.leave(open, target);
				return (failedIds) => {
					if (back && failedIds.includes(open)) back();
				};
			},
		};
	};
	// Same rule as the row-hide broadcast: only where the scope can leave again.
	if (!import.meta.server && getCurrentScope()) {
		guards.add(guard);
		onScopeDispose(() => guards.delete(guard));
	}
}

/**
 * PostboxThreadList's guard. A routed list (the folder view) navigates like the
 * reader's own delete: to the neighbour, else to the folder's list. A list that
 * previews in place (`selectable`: search, Today) hands its host the neighbour,
 * or null to close the preview.
 *
 * Also says which folder is Trash, so a move there counts as a delete.
 */
export function usePostboxListDeletedOpenRow(opts: {
	mailboxId: Ref<Id<'mailboxes'>>;
	/** The list's rows in visual order (after optimistic hiding). */
	orderedIds: Ref<readonly string[]>;
	/** The list's props: its open row, and whether it previews in place. */
	list: { activeMessageId?: string | null; selectable?: boolean };
	/** The in-place host's open row: show this one (null closes the preview). */
	select: (messageId: string | null) => void;
	/** The rows' folder route segment (a role, or a custom folder's id). */
	folderKey: Ref<string>;
	/** The list's query to keep on the route (`?placement=`). */
	query: Ref<string>;
}) {
	const router = useRouter();
	const { autoAdvance } = usePostboxSettings();

	function leaveRoute(left: string, target: string | null) {
		const folder = opts.folderKey.value;
		const query = opts.query.value;
		const targetPath = target
			? `/dashboard/postbox/${folder}/${target}`
			: `/dashboard/postbox/${folder}`;
		const navigation = Promise.resolve(navigateTo(targetPath + query));
		return () =>
			void navigation.then(() => {
				// A failure arriving after the person opened something else must not yank them.
				if (router.currentRoute.value.path !== targetPath) return;
				void navigateTo(`/dashboard/postbox/${folder}/${left}${query}`, { replace: true });
			});
	}

	function leaveInPlace(left: string, target: string | null) {
		opts.select(target);
		return () => {
			if ((opts.list.activeMessageId ?? null) === target) opts.select(left);
		};
	}

	usePostboxDeletedOpenRowGuard({
		orderedIds: () => opts.orderedIds.value,
		openId: () => opts.list.activeMessageId,
		autoAdvance: () => autoAdvance.value,
		leave: (left, target) =>
			opts.list.selectable === true ? leaveInPlace(left, target) : leaveRoute(left, target),
	});

	const { folders } = usePostboxFolders(opts.mailboxId);
	return {
		isTrashFolder: (folderId: string) =>
			folders.value.some((folder) => folder._id === folderId && folder.role === 'trash'),
	};
}
