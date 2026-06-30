/**
 * Per-mailbox label state + CRUD helpers.
 */

import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

export function usePostboxLabels(mailboxId: Ref<Id<'mailboxes'> | null>) {
	const { data, isLoading } = useConvexQuery(api.mail.labels.list, () =>
		mailboxId.value ? { mailboxId: mailboxId.value } : 'skip'
	);
	const labels = computed(() => data.value ?? []);

	const createLabel = useBackendOperation(api.mail.labels.create, {
		label: 'Create label',
	});
	const updateLabel = useBackendOperation(api.mail.labels.update, {
		label: 'Update label',
	});
	const removeLabel = useBackendOperation(api.mail.labels.remove, {
		label: 'Delete label',
	});
	const toggleOnMessage = useBackendOperation(api.mail.labels.toggleOnMessage, {
		label: 'Update message labels',
	});
	const toggleOnThread = useBackendOperation(api.mail.labels.toggleOnThread, {
		label: 'Update thread labels',
	});

	async function create(name: string, color?: string) {
		if (!mailboxId.value) return null;
		return createLabel.run({ mailboxId: mailboxId.value, name, color });
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

	async function setOnThread(
		threadId: Id<'mailThreads'>,
		labelId: Id<'mailLabels'>,
		add: boolean
	) {
		await toggleOnThread.run({ threadId, labelId, add });
	}

	return {
		labels,
		isLoading,
		create,
		rename,
		setColor,
		remove,
		setOnMessage,
		setOnThread,
	};
}
