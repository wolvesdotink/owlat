/**
 * The conversation PostboxThreadReader renders: the thread in pages, the
 * opened row standing in until the thread answers, which messages are
 * expanded, and the thread's own fields (labels, follow-up, placement, the
 * states its ⋯ menu checks). Also the mailbox's own addresses, which decide
 * whose mail is "ours" across the reader.
 */
import { computed } from 'vue';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { extractEmailAddress } from '~/utils/emailAddress';
import { placeAnchorRow } from './postboxThreadPage';
import type { PostboxReaderMessage, PostboxReaderThread } from './postboxReaderMessage';
import { usePostboxReaderExpansion } from './usePostboxReaderExpansion';
import { usePostboxReaderOpenRow } from './usePostboxReaderOpenRow';
import { usePostboxEnvelopeBodies, usePostboxThreadPages } from './usePostboxThreadPages';

export function usePostboxReaderConversation(message: () => PostboxReaderMessage) {
	// The mailbox's own addresses (canonical + active aliases) — excluded from the
	// Cc set on Reply-All so the user never adds themselves.
	const ownIdentitiesQuery = useConvexQuery(api.mail.identities.listForOwnedMailbox, () => ({
		mailboxId: message().mailboxId as Id<'mailboxes'>,
	}));

	const ownAddresses = computed(
		() =>
			new Set(
				((ownIdentitiesQuery.data.value as string[] | undefined) ?? []).map(extractEmailAddress)
			)
	);
	const ownEmail = computed(() => (ownIdentitiesQuery.data.value as string[] | undefined)?.[0]);

	const messageId = computed(() => message()._id as Id<'mailMessages'>);
	const threadKey = () => message().threadId ?? message()._id;
	// The conversation in pages (plan 3.3): the newest messages with bodies, older
	// ones as envelopes, earlier pages behind "Load earlier".
	const threadPages = usePostboxThreadPages({ messageId: () => message()._id, threadKey });
	const { data: threadData, isLoading } = threadPages.newest;

	// Until the thread answers, render the row the reader was opened with and
	// its inline body (plan 2.5) instead of a skeleton; the page subscribed both
	// from the route in parallel with the list, so they are usually here already.
	const openRow = usePostboxReaderOpenRow({
		message,
		threadMessages: () => threadData.value?.messages,
	});

	// Expanded messages: the default set is built once per thread from its newest
	// page, then only grows as messages arrive (see usePostboxReaderExpansion).
	const { expanded, toggleExpanded } = usePostboxReaderExpansion({
		threadKey,
		activeId: () => message()._id,
		messages: () => threadPages.newestRows.value,
		startsThread: () => threadPages.startsThread.value,
		// One page (read on arrival §3): earlier messages, read or not, are one
		// line each; the latest (and the opened one) are expanded.
		expandFirst: false,
		expandUnread: false,
	});
	// The opened message is always in the conversation, even before the page that
	// holds it has loaded; an expanded envelope gets its body folded in.
	const threadMessages = usePostboxEnvelopeBodies({
		rows: () => {
			const rows = threadPages.rows.value;
			return rows
				? placeAnchorRow<(typeof rows)[number] | PostboxReaderMessage>(rows, openRow.value)
				: undefined;
		},
		expanded: () => expanded.value,
		bodyIds: () => threadPages.bodyIds.value,
	});
	const allMessages = computed(() => threadMessages.value ?? [openRow.value]);
	/** What the header counts: the whole thread once part of it is not loaded. */
	const threadMessageCount = computed(() =>
		threadPages.hasEarlier.value
			? Math.max(threadData.value?.thread?.messageCount ?? 0, allMessages.value.length)
			: allMessages.value.length
	);
	const latestMessage = computed(() => allMessages.value[allMessages.value.length - 1]);

	// Follow-up ("remind me if no reply") chip: armable only while the thread
	// ends on our own sent message — an inbound reply on top means they already
	// answered (and clears any armed watch server-side anyway).
	const readerThread = computed(
		() => threadData.value?.thread as PostboxReaderThread | null | undefined
	);
	const latestOutboundId = computed(() => {
		const last = allMessages.value[allMessages.value.length - 1] as
			| { _id: string; outbound?: unknown }
			| undefined;
		return last && last.outbound !== undefined ? last._id : undefined;
	});

	const labelMap = computed(() => {
		const map = new Map<string, { _id: string; name: string; color?: string }>();
		for (const l of threadData.value?.labels ?? []) map.set(l._id, l);
		return map;
	});
	const threadLabels = computed(() => threadData.value?.thread?.labelIds ?? []);

	return {
		ownAddresses,
		ownEmail,
		messageId,
		threadKey,
		threadPages,
		threadData,
		isLoading,
		expanded,
		toggleExpanded,
		allMessages,
		threadMessageCount,
		latestMessage,
		readerThread,
		latestOutboundId,
		labelMap,
		threadLabels,
	};
}
