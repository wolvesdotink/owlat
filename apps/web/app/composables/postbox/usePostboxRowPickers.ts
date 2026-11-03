/**
 * The three "pick a thing for this row" dialogs of the thread list — snooze
 * (`h`), label (`l`) and move (`v`) — and the target they act on.
 *
 * The target id is CAPTURED when the dialog opens rather than read when it
 * closes: j/k keep moving while a dialog is up, and reading the focused row at
 * confirm time would snooze whatever the cursor had wandered onto. The snoozed
 * row's thread is captured with it for the same reason, so the dialog's default
 * "whole conversation" scope cannot retarget either.
 *
 * The move picker also offers the caller's other mailboxes
 * (`usePostboxMailboxTransfer`); its props and handlers travel as one bundle
 * each (`movePicker`, `movePickerOn`).
 *
 * Lifted out of PostboxThreadList.vue, which owns rendering and the keyboard
 * dispatch; this is state plus a few short commits, and nothing in it needs
 * the component.
 */

import type { Ref } from 'vue';
import type { Id } from '@owlat/api/dataModel';
import type { PostboxSnoozeScope } from '~/utils/postboxSnoozeScope';
import type { PostboxTransferMode } from './usePostboxMailboxTransfer';

export function usePostboxRowPickers(opts: {
	mailboxId: Ref<Id<'mailboxes'>>;
	/** The folder being shown — never a move destination for its own rows. */
	folderRole: Ref<string>;
	snoozeMsg: (id: Id<'mailMessages'>, until: number) => Promise<unknown>;
	snoozeThread: (id: Id<'mailMessages'>, threadId: string, until: number) => Promise<unknown>;
	moveMsg: (id: Id<'mailMessages'>, folderId: Id<'mailFolders'>) => Promise<unknown>;
}) {
	const snoozeOpen = ref(false);
	const snoozeTargetId = ref<Id<'mailMessages'> | null>(null);
	const snoozeTargetThreadId = ref<string | null>(null);
	const labelOpen = ref(false);
	const labelTargetId = ref<Id<'mailMessages'> | null>(null);
	const moveOpen = ref(false);
	const moveTargetId = ref<Id<'mailMessages'> | null>(null);

	const { labels, setOnMessage } = usePostboxLabels(opts.mailboxId);
	const { folders } = usePostboxFolders(opts.mailboxId);
	// Same destination filter as PostboxQuickActionsBar: moving a received
	// message into Sent/Drafts mis-frames it, and the current folder is a no-op.
	const movableFolders = computed(() =>
		folders.value.filter(
			(f) => f.role !== 'sent' && f.role !== 'drafts' && f.role !== opts.folderRole.value
		)
	);

	function openSnooze(id: Id<'mailMessages'>, threadId: string | null) {
		snoozeTargetId.value = id;
		snoozeTargetThreadId.value = threadId;
		snoozeOpen.value = true;
	}

	function openLabel(id: Id<'mailMessages'>) {
		labelTargetId.value = id;
		labelOpen.value = true;
	}

	function openMove(id: Id<'mailMessages'>) {
		moveTargetId.value = id;
		moveOpen.value = true;
	}

	async function snoozeFocused(until: number, scope: PostboxSnoozeScope) {
		const id = snoozeTargetId.value;
		const threadId = snoozeTargetThreadId.value;
		snoozeTargetId.value = null;
		snoozeTargetThreadId.value = null;
		if (!id) return;
		// Thread scope needs a thread to address; a row without one (legacy/partial
		// projection) falls back to deferring just the message rather than no-oping.
		if (scope === 'thread' && threadId) await opts.snoozeThread(id, threadId, until);
		else await opts.snoozeMsg(id, until);
	}

	async function applyLabelToFocused(labelId: Id<'mailLabels'>) {
		const id = labelTargetId.value;
		labelOpen.value = false;
		labelTargetId.value = null;
		if (id) await setOnMessage(id, labelId, true);
	}

	async function moveFocusedTo(targetFolderId: Id<'mailFolders'>) {
		const id = moveTargetId.value;
		moveOpen.value = false;
		moveTargetId.value = null;
		if (id) await opts.moveMsg(id, targetFolderId);
	}

	const mailboxTransfer = usePostboxMailboxTransfer(() => opts.mailboxId.value);
	async function transferFocusedTo(targetId: Id<'mailboxes'>, mode: PostboxTransferMode) {
		const id = moveTargetId.value;
		moveOpen.value = false;
		moveTargetId.value = null;
		if (!id || !(await mailboxTransfer.confirmTarget(targetId))) return;
		await mailboxTransfer.transfer([id], targetId, mode);
	}
	const movePicker = computed(() => ({
		folders: movableFolders.value,
		mailboxes: mailboxTransfer.targets.value,
		canMove: !mailboxTransfer.isSourceConnected.value,
	}));
	const movePickerOn = { pick: moveFocusedTo, 'pick-mailbox': transferFocusedTo };

	return {
		snoozeOpen,
		labelOpen,
		moveOpen,
		labels,
		movableFolders,
		movePicker,
		movePickerOn,
		openSnooze,
		openLabel,
		openMove,
		snoozeFocused,
		applyLabelToFocused,
		moveFocusedTo,
		transferFocusedTo,
	};
}
