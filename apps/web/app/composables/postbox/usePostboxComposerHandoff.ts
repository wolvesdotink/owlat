/**
 * How a composer hands its draft to the page around it:
 *
 *  - the draft id, emitted as soon as the row exists (created by the first
 *    autosave, or reopened), so Answer mode and the compose page can write it
 *    into their URL;
 *  - discard, then tell the host;
 *  - what the host reads as it leaves: the row, who it is for, whether it
 *    holds anything.
 */
import { watch, type Ref } from 'vue';
import type { Id } from '@owlat/api/dataModel';
import { answerDraftHasContent } from '~/utils/answerMode';

export function usePostboxComposerHandoff(opts: {
	draftId: Readonly<Ref<Id<'mailDrafts'> | null | undefined>>;
	toAddresses: Readonly<Ref<string[]>>;
	bodyHtml: Readonly<Ref<string>>;
	attachmentCount: () => number;
	discard: () => Promise<unknown>;
	emitDiscarded: () => void;
	emitDraftId: (draftId: Id<'mailDrafts'>) => void;
}) {
	watch(
		opts.draftId,
		(id) => {
			if (id) opts.emitDraftId(id);
		},
		{ immediate: true }
	);

	async function handleDiscard() {
		await opts.discard();
		opts.emitDiscarded();
	}

	const snapshot = () => ({
		draftId: opts.draftId.value ?? null,
		toAddresses: [...opts.toAddresses.value],
		hasContent: answerDraftHasContent(opts.bodyHtml.value, opts.attachmentCount()),
	});

	return { handleDiscard, snapshot };
}
