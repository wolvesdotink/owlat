/**
 * Where the composer shows a draft's inline body images from (#1285).
 *
 * A pasted image is saved as `<img data-inline-cid="X">` with no `src`, its
 * bytes as the inline part `X` on the draft row. The preview the paste showed
 * does not survive a reload or reach another device, so the editor shows each
 * image from its part's storage URL (`mail.draftInlineImages.urls`, gated like
 * `drafts.get`). Only subscribed while the body holds an inline image.
 */

import type { Ref } from 'vue';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

export function usePostboxDraftInlineImages(
	draftId: Readonly<Ref<Id<'mailDrafts'> | null>>,
	bodyHtml: Readonly<Ref<string>>
) {
	const query = useConvexQuery(api.mail.draftInlineImages.urls, () =>
		draftId.value && bodyHtml.value.includes('data-inline-cid')
			? { draftId: draftId.value }
			: ('skip' as const)
	);
	return computed<ReadonlyMap<string, string>>(
		() => new Map((query.data.value ?? []).map((part) => [part.contentId, part.url]))
	);
}
