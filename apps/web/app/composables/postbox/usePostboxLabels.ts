/**
 * Per-mailbox label state + CRUD helpers.
 *
 * Labels nest (idea 38), so this also exposes the assembled tree and the
 * per-label unread counts the rail badges. The tree build itself is a pure
 * function in `~/utils/postboxLabelTree` — this composable only supplies it
 * with live rows.
 */

import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { buildLabelTree } from '~/utils/postboxLabelTree';
import { optimisticReorderLabels, optimisticUpdateLabel } from '~/lib/mailOptimistic/labelUpdaters';
import {
	optimisticSetLabelOnMessages,
	optimisticToggleLabelOnMessage,
	optimisticToggleLabelOnThread,
} from '~/lib/mailOptimistic/mailUpdaters';

export function usePostboxLabels(mailboxId: Ref<Id<'mailboxes'> | null>) {
	const { t } = useI18n();
	const { data, isLoading } = useConvexQuery(api.mail.labels.list, () =>
		mailboxId.value ? { mailboxId: mailboxId.value } : 'skip'
	);
	const labels = computed(() => data.value ?? []);

	const { data: unreadData } = useConvexQuery(api.mail.labels.unreadCounts, () =>
		mailboxId.value ? { mailboxId: mailboxId.value } : 'skip'
	);
	/** Sparse: a label with no unread mail is simply absent, i.e. no badge. */
	const unreadCounts = computed<Record<string, number>>(() => unreadData.value?.counts ?? {});
	const labelTree = computed(() => buildLabelTree(labels.value, unreadCounts.value));

	const createLabel = useBackendOperation(api.mail.labels.create, {
		label: () => t('shared.postbox.usePostboxLabels.createLabel'),
	});
	// Rename, colour, pin, re-parent and reorder settle in place, and a label
	// applied to mail shows on its rows at once (plan 2.2).
	const updateLabel = useBackendOperation(api.mail.labels.update, {
		label: () => t('shared.postbox.usePostboxLabels.updateLabel'),
		optimisticUpdate: optimisticUpdateLabel,
	});
	const removeLabel = useBackendOperation(api.mail.labels.remove, {
		label: () => t('shared.postbox.usePostboxLabels.deleteLabel'),
	});
	const toggleOnMessage = useBackendOperation(api.mail.labels.toggleOnMessage, {
		label: () => t('shared.postbox.usePostboxLabels.updateMessageLabels'),
		optimisticUpdate: optimisticToggleLabelOnMessage,
	});
	const addToMessages = useBackendOperation(api.mail.labels.setOnMessages, {
		label: () => t('shared.postbox.usePostboxLabels.updateMessageLabels'),
		optimisticUpdate: optimisticSetLabelOnMessages,
	});
	const toggleOnThread = useBackendOperation(api.mail.labels.toggleOnThread, {
		label: () => t('shared.postbox.usePostboxLabels.updateThreadLabels'),
		optimisticUpdate: optimisticToggleLabelOnThread,
	});

	const reorderLabels = useBackendOperation(api.mail.labels.reorder, {
		label: () => t('shared.postbox.usePostboxLabels.reorderLabels'),
		optimisticUpdate: optimisticReorderLabels,
	});

	/**
	 * `name` may be a path (`Work/Clients/Acme`): the backend creates every
	 * missing ancestor and returns the leaf, so nesting is one action.
	 */
	async function create(name: string, color?: string, parentId?: Id<'mailLabels'>) {
		if (!mailboxId.value) return null;
		return createLabel.run({ mailboxId: mailboxId.value, name, color, parentId });
	}

	/** `null` moves the label back out to a root. */
	async function setParent(labelId: Id<'mailLabels'>, parentId: Id<'mailLabels'> | null) {
		await updateLabel.run({ labelId, parentId });
	}

	async function setPinned(labelId: Id<'mailLabels'>, isPinned: boolean) {
		await updateLabel.run({ labelId, isPinned });
	}

	/** Write a sibling run's new order — the shared half of drag and keyboard. */
	async function reorder(labelIds: Id<'mailLabels'>[]) {
		if (!mailboxId.value) return;
		await reorderLabels.run({ mailboxId: mailboxId.value, labelIds });
	}

	async function rename(labelId: Id<'mailLabels'>, name: string) {
		await updateLabel.run({ labelId, name });
	}

	async function setColor(labelId: Id<'mailLabels'>, color: string | undefined) {
		await updateLabel.run({ labelId, color: color ?? '' });
	}

	async function remove(labelId: Id<'mailLabels'>) {
		await removeLabel.run({ labelId });
	}

	async function setOnMessage(
		messageId: Id<'mailMessages'>,
		labelId: Id<'mailLabels'>,
		add: boolean
	) {
		await toggleOnMessage.run({ messageId, labelId, add });
	}

	/** Add a label to many messages in one mutation (a dragged selection). */
	function applyToMessages(messageIds: Id<'mailMessages'>[], labelId: Id<'mailLabels'>) {
		return addToMessages.run({ messageIds, labelId, add: true });
	}

	async function setOnThread(threadId: Id<'mailThreads'>, labelId: Id<'mailLabels'>, add: boolean) {
		await toggleOnThread.run({ threadId, labelId, add });
	}

	return {
		labels,
		labelTree,
		unreadCounts,
		isLoading,
		create,
		setParent,
		setPinned,
		reorder,
		rename,
		setColor,
		remove,
		setOnMessage,
		applyToMessages,
		setOnThread,
	};
}
