import type { MaybeRefOrGetter } from 'vue';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { resolvePostboxMessageBody } from './postboxBodyResolver';
import { inlineBodyNeedsBlob } from './usePostboxPrefetch';
import { threadPageArgs } from './postboxThreadPage';

/**
 * The open message's queries, started from the route's message id (plan 2.5).
 *
 * Opening a message used to be a chain: the mailbox guard waited for the
 * mailbox list, the layout for the list page (or `getMessage`), the reader
 * mounted and only then subscribed its thread, and the body came last from an
 * action. The page now calls this with the route param, before the mailbox
 * guard has resolved, so the thread (`listThreadMessages`) and the inline body
 * (`getMessageInlineBody`) load in parallel with the list. The reader asks for
 * the same queries with the same args and joins these subscriptions through
 * the shared registry instead of starting its own. A body stored as a blob
 * starts its download from here too.
 *
 * Both queries check mailbox access on the server; nothing here renders.
 */
export function usePostboxOpenMessage(messageId: MaybeRefOrGetter<string | null | undefined>) {
	const openId = computed(() => toValue(messageId) || null);

	// The reader's newest page (plan 3.3), so the reader joins this subscription.
	const thread = useConvexQuery(api.mail.mailbox.messages.listThreadMessages, () =>
		openId.value ? threadPageArgs(openId.value) : 'skip'
	);

	/** The open message's own row in its thread, once the thread has loaded. */
	const threadMessage = computed(() => {
		const id = openId.value;
		if (!id) return undefined;
		return thread.data.value?.messages.find((m) => m._id === id);
	});

	// The body, in parallel with the thread; released once the thread row
	// (which carries the body) is here.
	const { data: inlineBody } = useConvexQuery(api.mail.mailbox.messages.getMessageInlineBody, () =>
		openId.value && !threadMessage.value
			? { messageId: openId.value as Id<'mailMessages'> }
			: 'skip'
	);

	// A body over the inline threshold only exists as a blob, which needs the
	// URL-minting action and a download. Start both as soon as the inline query
	// says so, into the shared body cache the reader's body consumes, instead of
	// waiting for the reader to mount on the thread row. Fail-soft: the reader
	// retries for itself and shows its own error state.
	const client = useConvex();
	watch([openId, inlineBody], ([id, body]) => {
		if (!client || !id || !inlineBodyNeedsBlob(body)) return;
		resolvePostboxMessageBody(client, id, { blobOnly: true }).catch(() => {});
	});

	return {
		threadMessage,
		/** The thread query has answered (or failed): its row is known to be there or not. */
		threadSettled: computed(() => !thread.isLoading.value),
	};
}

/**
 * The message the layout hands the reader: the list row when it is loaded,
 * else the open message's row from its thread, else (a message the thread
 * read does not reach) a `getMessage` fetch by id. The fetch only starts once
 * the thread has answered without it, so a deep link costs no extra query.
 */
export function usePostboxActiveMessage<Row extends { _id: string }>(source: {
	activeMessageId: () => string | null | undefined;
	listRows: () => readonly Row[];
}) {
	return usePostboxActiveMessageRead(source).message;
}

/**
 * `usePostboxActiveMessage` plus the read's outcome, for a surface whose main
 * content is the message (Answer mode, the reader pane). The by-id fetch is the
 * last source, so its `error` means the message could not be read at all
 * (#721), and its `null` answer means there is no such message for this viewer:
 * deleted, moved by another client, purged, or its mailbox no longer shared
 * (`notFound`). A skipped fetch reports neither.
 */
export function usePostboxActiveMessageRead<Row extends { _id: string }>(source: {
	activeMessageId: () => string | null | undefined;
	listRows: () => readonly Row[];
}) {
	const listActive = computed(() => {
		const id = source.activeMessageId();
		return id ? source.listRows().find((m) => m._id === id) : undefined;
	});
	const { threadMessage, threadSettled } = usePostboxOpenMessage(() => source.activeMessageId());
	const fetchArgs = computed(() => {
		const id = source.activeMessageId();
		return id && !listActive.value && !threadMessage.value && threadSettled.value
			? { messageId: id as Id<'mailMessages'> }
			: 'skip';
	});
	const {
		data: fetchedActive,
		isLoading: fetchLoading,
		error,
		refetch,
	} = useConvexQuery(api.mail.mailbox.messages.getMessage, () => fetchArgs.value);
	const message = computed(
		() => listActive.value ?? threadMessage.value ?? fetchedActive.value ?? undefined
	);
	const notFound = computed(
		() =>
			fetchArgs.value !== 'skip' &&
			!fetchLoading.value &&
			!error.value &&
			fetchedActive.value === null
	);
	return { message, notFound, error, refetch };
}
