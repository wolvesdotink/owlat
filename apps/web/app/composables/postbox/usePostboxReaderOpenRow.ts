import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { FunctionReturnType } from 'convex/server';
import { inlineBodyNeedsBlob } from './usePostboxPrefetch';

/**
 * The message the reader shows while its thread is still loading (plan 2.5).
 *
 * The reader used to hold a skeleton until `listThreadMessages` answered. It
 * now renders the row it was opened with straight away: the list row, which
 * carries no body since plan 2.3, plus the body from `getMessageInlineBody`.
 * The Postbox page subscribes that query from the route's message id in
 * parallel with the list, and the read-ahead holds it for the neighbouring
 * rows, so the reader's own subscription usually joins a loaded one.
 *
 * Once the thread arrives its rows (which carry their bodies) take over and
 * the inline query is released.
 */

type InlineBody = FunctionReturnType<typeof api.mail.mailbox.messages.getMessageInlineBody>;

export interface OpenRowMessage {
	_id: string;
	htmlBodyInline?: string;
	textBodyInline?: string;
	htmlBodyStorageId?: string;
	textBodyStorageId?: string;
	hasBodyBlob?: boolean;
	bodyPending?: boolean;
}

/** The row already says where its body is (inline, or a storage blob). */
export function rowCarriesBody(message: OpenRowMessage): boolean {
	return !!(
		message.htmlBodyInline ||
		message.textBodyInline ||
		message.htmlBodyStorageId ||
		message.textBodyStorageId
	);
}

/**
 * The open row with the inline body query's answer folded in: pending while
 * the query loads, the inline html/text once it answers, `hasBodyBlob` when
 * the body only exists as a blob. A failed or empty answer leaves the row as
 * it is, which renders as "(empty message)".
 */
export function withInlineBody<T extends OpenRowMessage>(
	message: T,
	body: InlineBody | undefined,
	failed: boolean
): T {
	if (body === undefined) return failed ? message : { ...message, bodyPending: true };
	if (body === null) return message;
	return {
		...message,
		htmlBodyInline: body.htmlInline ?? undefined,
		textBodyInline: body.textInline ?? undefined,
		hasBodyBlob: inlineBodyNeedsBlob(body),
	};
}

export function usePostboxReaderOpenRow<T extends OpenRowMessage>(source: {
	message: () => T;
	/** The thread's messages, or undefined while `listThreadMessages` loads. */
	threadMessages: () => readonly unknown[] | undefined;
}) {
	const needsBody = computed(
		() => source.threadMessages() === undefined && !rowCarriesBody(source.message())
	);
	const { data, error } = useConvexQuery(api.mail.mailbox.messages.getMessageInlineBody, () =>
		needsBody.value ? { messageId: source.message()._id as Id<'mailMessages'> } : 'skip'
	);
	return computed<T>(() =>
		needsBody.value
			? withInlineBody(source.message(), data.value, error.value !== null)
			: source.message()
	);
}
