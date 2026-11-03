/**
 * Move or copy messages into ANOTHER mailbox: the "Other mailboxes" half of the
 * move picker (`v`) and the palette's "Move to mailbox…" / "Copy to mailbox…".
 *
 * The server (`mail.mailboxTransfer.transfer`) writes the copy before it
 * deletes the source and refuses what may not travel; this is the client half:
 * which mailboxes are offered, the one-time confirmation before mail goes into
 * a team inbox (every member will see it), and the undo. A move is undone by
 * moving each copy back to the folder its source sat in; a copy, by purging the
 * copies.
 *
 * A connected (IMAP) account is listed but cannot be picked, and a move out of
 * one is offered as a copy only: nothing writes to the provider yet, so the
 * server refuses both, and the picker says so instead of failing on click.
 */

import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { OperationError } from '@owlat/shared/operationError';
import { readStoredStringList } from '~/utils/storedValue';
import { hidePostboxRowEverywhere, unhidePostboxRowEverywhere } from './usePostboxOptimisticHide';

export type PostboxTransferMode = 'move' | 'copy';

/** One mailbox the picker offers as a destination. */
export interface PostboxTransferTarget {
	mailboxId: Id<'mailboxes'>;
	name: string;
	isShared: boolean;
	/** A connected account: shown, never pickable. */
	isConnected: boolean;
}

/** Messages per call, matching the server's `MAX_MESSAGES_PER_TRANSFER`. */
export const POSTBOX_MESSAGES_PER_TRANSFER = 25;

/** Team inboxes this browser already confirmed filing mail into. */
const CONFIRMED_KEY = 'postbox-transfer-confirmed-team-inboxes';

const REFUSALS = new Set(['external_target', 'external_source', 'sealed', 'sending', 'over_quota']);

function chunks<T>(items: readonly T[]): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += POSTBOX_MESSAGES_PER_TRANSFER) {
		out.push(items.slice(i, i + POSTBOX_MESSAGES_PER_TRANSFER));
	}
	return out;
}

export function usePostboxMailboxTransfer(mailboxId: () => string) {
	const { t } = useI18n();
	const { showToast } = useToast();
	const confirm = useConfirm();
	const triageUndo = usePostboxTriageUndo();
	const { inboxes } = useInboxes();
	const { data: confirmed, set: setConfirmed } = useLocalStorage<string[]>(
		CONFIRMED_KEY,
		[],
		readStoredStringList
	);

	const K = 'components.postbox.postboxMovePickerDialog';
	const transferOp = useBackendOperation(api.mail.mailboxTransfer.transfer, {
		label: () => t('components.postbox.postboxMovePickerDialog.transferOperation'),
		// A refusal is a rule of the feature, not a fault: say which one.
		onError: (error: OperationError) => {
			const reason = error.data?.['reason'];
			if (typeof reason !== 'string' || !REFUSALS.has(reason)) return false;
			showToast(t(`${K}.refused.${reason}`), 'error');
			return true;
		},
	});
	const purgeOp = useBackendOperation(api.mail.messageActions.purge, {
		label: () => t('components.postbox.postboxMovePickerDialog.undoCopyOperation'),
	});

	const isSourceConnected = computed(
		() => inboxes.value.find((inbox) => inbox.mailboxId === mailboxId())?.isConnected === true
	);
	const targets = computed<PostboxTransferTarget[]>(() =>
		inboxes.value
			.filter((inbox) => inbox.mailboxId !== mailboxId())
			.map((inbox) => ({
				mailboxId: inbox.mailboxId,
				name: inbox.name,
				isShared: inbox.scope === 'shared',
				isConnected: inbox.isConnected === true,
			}))
	);

	/**
	 * Ask once per team inbox before filing mail into it: every member will see
	 * it. Resolves to whether to go ahead.
	 */
	async function confirmTarget(targetId: Id<'mailboxes'>): Promise<boolean> {
		const target = targets.value.find((m) => m.mailboxId === targetId);
		if (!target?.isShared || confirmed.value.includes(targetId)) return true;
		const ok = await confirm({
			title: t('components.postbox.postboxMovePickerDialog.confirmTeamTitle', {
				name: target.name,
			}),
			body: t('components.postbox.postboxMovePickerDialog.confirmTeamBody', { name: target.name }),
			confirmText: t('components.postbox.postboxMovePickerDialog.confirmTeamAction'),
		});
		if (ok) setConfirmed([...confirmed.value, targetId]);
		return ok;
	}

	function registerUndo(
		mode: PostboxTransferMode,
		target: PostboxTransferTarget | undefined,
		sourceMailboxId: Id<'mailboxes'>,
		moved: Array<{ messageId: Id<'mailMessages'>; sourceFolderId: Id<'mailFolders'> }>,
		hidden: Id<'mailMessages'>[]
	) {
		const name = target?.name ?? '';
		triageUndo.register({
			label:
				mode === 'move'
					? t('components.postbox.postboxMovePickerDialog.movedTo', { name }, moved.length)
					: t('components.postbox.postboxMovePickerDialog.copiedTo', { name }, moved.length),
			inverse: async () => {
				const copies = moved.map((entry) => entry.messageId);
				if (mode === 'copy') {
					for (const chunk of chunks(copies)) await purgeOp.run({ messageIds: chunk });
					return;
				}
				const byFolder = new Map<Id<'mailFolders'>, Id<'mailMessages'>[]>();
				for (const entry of moved) {
					byFolder.set(entry.sourceFolderId, [
						...(byFolder.get(entry.sourceFolderId) ?? []),
						entry.messageId,
					]);
				}
				for (const [folderId, ids] of byFolder) {
					for (const chunk of chunks(ids)) {
						await transferOp.run({
							messageIds: chunk,
							targetMailboxId: sourceMailboxId,
							targetFolderId: folderId,
							mode: 'move',
						});
					}
				}
				for (const id of hidden) unhidePostboxRowEverywhere(id);
			},
		});
	}

	/**
	 * Move or copy `ids` into `targetId`. A move hides the rows at once and
	 * brings back any the server did not take. Resolves to whether every call
	 * landed. The caller confirms the target first ({@link confirmTarget}).
	 */
	async function transfer(
		ids: Id<'mailMessages'>[],
		targetId: Id<'mailboxes'>,
		mode: PostboxTransferMode
	): Promise<boolean> {
		if (ids.length === 0) return false;
		const sourceMailboxId = mailboxId() as Id<'mailboxes'>;
		const target = targets.value.find((m) => m.mailboxId === targetId);
		if (mode === 'move') for (const id of ids) hidePostboxRowEverywhere(id);
		const moved: Array<{ messageId: Id<'mailMessages'>; sourceFolderId: Id<'mailFolders'> }> = [];
		const kept: Id<'mailMessages'>[] = [];
		let landed = 0;
		let isAllLanded = true;
		for (const chunk of chunks(ids)) {
			const outcome = await transferOp.run({ messageIds: chunk, targetMailboxId: targetId, mode });
			if (!outcome.ok || !outcome.result) {
				isAllLanded = false;
				break;
			}
			landed += chunk.length;
			moved.push(...outcome.result.moved);
			kept.push(...outcome.result.skipped);
		}
		const restored = [...ids.slice(landed), ...kept];
		if (mode === 'move') for (const id of restored) unhidePostboxRowEverywhere(id);
		if (kept.length > 0) {
			showToast(
				t(
					'components.postbox.postboxMovePickerDialog.alreadyThere',
					{ name: target?.name ?? '' },
					kept.length
				),
				'info'
			);
		}
		if (moved.length > 0) {
			const hidden = ids.slice(0, landed).filter((id) => !kept.includes(id));
			registerUndo(mode, target, sourceMailboxId, moved, hidden);
		}
		return isAllLanded;
	}

	return { targets, isSourceConnected, confirmTarget, transfer };
}
