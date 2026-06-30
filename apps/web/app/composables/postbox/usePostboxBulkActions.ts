/**
 * Bulk-selection state + triage actions for the thread/message list.
 *
 * Selection lives in a per-mailbox useState bucket so navigating between
 * folders doesn't carry stale picks across.
 */

import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

export function usePostboxBulkActions(mailboxId: Ref<Id<'mailboxes'> | null>) {
	const stateKey = computed(
		() => `postbox:bulk:${mailboxId.value ?? 'no-mailbox'}`
	);

	const selected = useState<Set<Id<'mailMessages'>>>(stateKey.value, () => new Set());

	function isSelected(id: Id<'mailMessages'>) {
		return selected.value.has(id);
	}

	function toggle(id: Id<'mailMessages'>) {
		const next = new Set(selected.value);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		selected.value = next;
	}

	function selectMany(ids: Id<'mailMessages'>[]) {
		const next = new Set(selected.value);
		for (const id of ids) next.add(id);
		selected.value = next;
	}

	function clear() {
		selected.value = new Set();
	}

	const count = computed(() => selected.value.size);
	const ids = computed(() => Array.from(selected.value));

	const setFlags = useBackendOperation(api.mail.messageActions.setFlags, {
		label: 'Update messages',
	});
	const archive = useBackendOperation(api.mail.messageActions.archive, {
		label: 'Archive messages',
	});
	const trash = useBackendOperation(api.mail.messageActions.trash, {
		label: 'Move messages to trash',
	});
	const purge = useBackendOperation(api.mail.messageActions.purge, {
		label: 'Delete messages',
	});
	const move = useBackendOperation(api.mail.messageActions.move, {
		label: 'Move messages',
	});
	const reportSpamOp = useBackendOperation(api.mail.messageActions.reportSpam, {
		label: 'Report spam',
	});
	const notSpamOp = useBackendOperation(api.mail.messageActions.notSpam, {
		label: 'Not spam',
	});

	async function markRead(seen: boolean) {
		if (ids.value.length === 0) return;
		await setFlags.run({ messageIds: ids.value, seen });
	}

	async function star(starred: boolean) {
		if (ids.value.length === 0) return;
		await setFlags.run({ messageIds: ids.value, flagged: starred });
	}

	async function archiveSelected() {
		if (ids.value.length === 0) return;
		const result = await archive.run({ messageIds: ids.value });
		if (result === undefined) return;
		clear();
	}

	async function trashSelected() {
		if (ids.value.length === 0) return;
		const result = await trash.run({ messageIds: ids.value });
		if (result === undefined) return;
		clear();
	}

	async function purgeSelected() {
		if (ids.value.length === 0) return;
		const result = await purge.run({ messageIds: ids.value });
		if (result === undefined) return;
		clear();
	}

	async function moveSelected(targetFolderId: Id<'mailFolders'>) {
		if (ids.value.length === 0) return;
		const result = await move.run({ messageIds: ids.value, targetFolderId });
		if (result === undefined) return;
		clear();
	}

	async function reportSpamSelected() {
		if (ids.value.length === 0) return;
		const result = await reportSpamOp.run({ messageIds: ids.value });
		if (result === undefined) return;
		clear();
	}

	async function notSpamSelected() {
		if (ids.value.length === 0) return;
		const result = await notSpamOp.run({ messageIds: ids.value });
		if (result === undefined) return;
		clear();
	}

	return {
		selected,
		ids,
		count,
		isSelected,
		toggle,
		selectMany,
		clear,
		markRead,
		star,
		archiveSelected,
		trashSelected,
		purgeSelected,
		moveSelected,
		reportSpamSelected,
		notSpamSelected,
	};
}
