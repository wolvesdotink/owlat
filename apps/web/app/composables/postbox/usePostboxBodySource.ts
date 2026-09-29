import { consumeResolvedPostboxMessageBody } from './postboxBodyResolver';

/**
 * Where a rendered message body comes from, and whether it is final yet.
 *
 * Most bodies travel inline on the message (the thread query, or the reader's
 * `getMessageInlineBody` subscription while the thread loads). Two cases wait:
 *
 *  - `bodyPending`: the reader opened on a list row and the inline body query
 *    has not answered yet. Nothing to fetch; the skeleton holds the space.
 *  - a blob: bodies over the inline threshold are stored as blobs, named by a
 *    storage id on a thread row or by `hasBodyBlob` from the inline query. They
 *    are resolved through the URL-minting action and a download, shared with
 *    the read-ahead through the client-scoped body cache.
 */
export interface PostboxBodySourceMessage {
	_id?: string;
	htmlBodyInline?: string;
	textBodyInline?: string;
	htmlBodyStorageId?: string;
	textBodyStorageId?: string;
	/** The inline body query reported a blob-only body. */
	hasBodyBlob?: boolean;
	/** The inline body has not arrived yet (reader opened on a list row). */
	bodyPending?: boolean;
}

export function usePostboxBodySource(message: () => PostboxBodySourceMessage) {
	const fetchedHtml = ref<string | null>(null);
	const fetchedText = ref<string | null>(null);

	const bodyPending = computed(() => message().bodyPending === true);

	const needsBodyFetch = computed(() => {
		const m = message();
		return (
			!bodyPending.value &&
			!m.htmlBodyInline &&
			!m.textBodyInline &&
			!!(m.htmlBodyStorageId || m.textBodyStorageId || m.hasBodyBlob)
		);
	});

	// Flips once the lazy body fetch has resolved (with content, empty, or a
	// failed blob download) so the loading skeleton can't outlive the fetch.
	const bodyFetchSettled = ref(false);
	const bodyError = ref<unknown>(null);
	let bodyRequestSequence = 0;

	watch(
		[needsBodyFetch, () => message()._id],
		async ([shouldFetch, messageId]) => {
			const requestSequence = ++bodyRequestSequence;
			fetchedHtml.value = null;
			fetchedText.value = null;
			bodyError.value = null;

			if (!shouldFetch || !messageId) {
				bodyFetchSettled.value = true;
				return;
			}

			bodyFetchSettled.value = false;
			try {
				// Only reached without an inline body, so skip the inline query and
				// go straight to the blob URL action.
				const resolvedBody = await consumeResolvedPostboxMessageBody(requireConvex(), messageId, {
					blobOnly: true,
				});
				if (requestSequence !== bodyRequestSequence) return;
				if (resolvedBody === null) return;
				fetchedHtml.value = resolvedBody.html;
				fetchedText.value = resolvedBody.text;
			} catch (error) {
				if (requestSequence !== bodyRequestSequence) return;
				bodyError.value = error;
				// Leave empty — the reader shows "(empty message)".
			} finally {
				if (requestSequence === bodyRequestSequence) {
					bodyFetchSettled.value = true;
				}
			}
		},
		{ immediate: true }
	);

	/** Still waiting for the body: the inline answer, or the blob download. */
	const waiting = computed(
		() => bodyPending.value || (needsBodyFetch.value && !bodyFetchSettled.value && !bodyError.value)
	);
	/** The body content will not change any more (safe to memoise its render). */
	const contentFinal = computed(
		() => !bodyPending.value && (!needsBodyFetch.value || bodyFetchSettled.value)
	);

	const effectiveHtml = computed(() => message().htmlBodyInline ?? fetchedHtml.value ?? undefined);
	const effectiveText = computed(() => message().textBodyInline ?? fetchedText.value ?? '');

	return { waiting, contentFinal, effectiveHtml, effectiveText };
}
