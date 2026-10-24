/**
 * Pinned conversations (mail/pins.ts) on the client: the band's live read and
 * the ONE pin/unpin operation every entry point runs.
 *
 * The row menu, the reader's ⋯ menu, the command palette, the band's own
 * unpin button and a drop onto the band all call {@link usePostboxPinAction},
 * so the label, the failure toast (a full band says so in the person's
 * language) and the optimistic band update are written once.
 *
 * The band reads its conversations from their own query, not from the list's
 * pages: a pinned conversation whose newest mail is weeks old, or no longer in
 * the Inbox, still shows.
 */

import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { OptimisticLocalStore } from 'convex/browser';
import type { FunctionReturnType } from 'convex/server';
import { toValue, type MaybeRefOrGetter } from 'vue';
import { updateQueries } from '~/lib/optimisticStore';

export type PostboxPinnedConversation = FunctionReturnType<
	typeof api.mail.pins.listPinned
>['conversations'][number];

/** The band's size when the read has not answered yet; the server's limit wins. */
const FALLBACK_LIMIT = 5;

/**
 * Drop an unpinned conversation from the band at once. Matches on the band
 * entry's message id, which is what the band's own unpin sends; an unpin from
 * an older message of the thread waits for the server, a beat later.
 */
export function optimisticUnpin(
	store: OptimisticLocalStore,
	args: { messageIds: Id<'mailMessages'>[]; pinned: boolean }
): void {
	if (args.pinned) return;
	const ids = new Set<string>(args.messageIds);
	updateQueries(store, api.mail.pins.listPinned, (value) => {
		const conversations = value.conversations.filter((c) => !ids.has(c.messageId));
		return conversations.length === value.conversations.length
			? value
			: { ...value, conversations };
	});
}

/** The mailbox's pinned band, live. */
export function usePostboxPinnedConversations(
	mailboxId: MaybeRefOrGetter<Id<'mailboxes'> | null | undefined>
) {
	const { data, isLoading, error } = useConvexQuery(api.mail.pins.listPinned, () => {
		const id = toValue(mailboxId);
		return id ? { mailboxId: id } : 'skip';
	});
	const conversations = computed<PostboxPinnedConversation[]>(
		() => data.value?.conversations ?? []
	);
	const limit = computed(() => data.value?.limit ?? FALLBACK_LIMIT);
	return {
		conversations,
		limit,
		isFull: computed(() => conversations.value.length >= limit.value),
		isLoading,
		error,
	};
}

/** Pin or unpin conversations, keyed by any of their messages. */
export function usePostboxPinAction() {
	const { t } = useI18n();
	const op = useBackendOperation(api.mail.pins.setPinned, {
		label: () => t('postbox.pins.operation'),
		optimisticUpdate: optimisticUnpin,
	});

	/** Resolves to whether the write landed. */
	async function setPinned(messageIds: Id<'mailMessages'>[], pinned: boolean): Promise<boolean> {
		if (messageIds.length === 0) return false;
		return (await op.run({ messageIds, pinned })).ok;
	}

	return {
		setPinned,
		/** Flip one conversation, given whether it is pinned now. */
		toggle: (messageId: Id<'mailMessages'>, isPinned: boolean) => setPinned([messageId], !isPinned),
		isLoading: op.isLoading,
	};
}
