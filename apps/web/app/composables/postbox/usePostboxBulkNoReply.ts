/**
 * "None of these need a reply" for a whole group: clears each conversation's
 * reply flag the way a card's "No reply needed" does, and offers one undo that
 * puts every flag back (the server kept each one aside).
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { PeopleTopic } from '~/utils/postboxPeople';

export function usePostboxBulkNoReply() {
	const { t } = useI18n();
	const clearOp = useBackendOperation(api.mail.needsReply.clear, {
		label: () => t('components.postbox.people.topic.noReplyNeeded'),
	});
	const restoreOp = useBackendOperation(api.mail.needsReplyRestore.restore, {
		label: () => t('components.postbox.people.topic.noReplyUndone'),
	});
	const triageUndo = usePostboxTriageUndo();
	const isClearing = ref(false);

	async function clearAll(topics: readonly PeopleTopic[]) {
		if (topics.length === 0 || isClearing.value) return;
		isClearing.value = true;
		const cleared: Id<'mailThreads'>[] = [];
		try {
			for (const topic of topics) {
				const threadId = topic.id as Id<'mailThreads'>;
				if ((await clearOp.run({ threadId })).ok) cleared.push(threadId);
			}
		} finally {
			isClearing.value = false;
		}
		if (cleared.length === 0) return;
		triageUndo.register({
			label: t(
				'components.postbox.people.column.clearedMaybes',
				{ count: cleared.length },
				cleared.length
			),
			inverse: async () => {
				for (const threadId of cleared) await restoreOp.run({ threadId });
			},
		});
	}

	return { clearAll, isClearing };
}
