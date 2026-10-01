/**
 * How a composer hands its draft to the page around it:
 *
 *  - the draft id, emitted as soon as the row exists (created by the first
 *    autosave, or reopened), so Answer mode can write it into its URL;
 *  - popup reply → Answer mode ("maximise"): flush the debounced autosave first
 *    (creating the row if needed) so Answer mode reopens the SAME draft. A flush
 *    that did not save (a rejected save, fields still changing, a body not yet
 *    loaded) keeps the reply in its popup, where its text still is and the
 *    draft notice says why, instead of reopening a row that lacks it;
 *  - discard, then tell the host;
 *  - what the host reads as it leaves: the row, who it is for, whether it
 *    holds anything.
 *
 * This took over the inline reply box's promote-to-popup (#895), which Answer
 * mode replaced.
 */
import { ref, watch, type Ref } from 'vue';
import type { Id } from '@owlat/api/dataModel';
import type { BackendOperationResult } from '~/composables/useBackendOperation';
import { answerDraftHasContent } from '~/utils/answerMode';

export function usePostboxComposerHandoff(opts: {
	draftId: Readonly<Ref<Id<'mailDrafts'> | null | undefined>>;
	toAddresses: Readonly<Ref<string[]>>;
	bodyHtml: Readonly<Ref<string>>;
	attachmentCount: () => number;
	flush: () => Promise<BackendOperationResult<Id<'mailDrafts'> | null>>;
	discard: () => Promise<unknown>;
	emitDiscarded: () => void;
	emitDraftId: (draftId: Id<'mailDrafts'>) => void;
	emitMaximise: (draftId: Id<'mailDrafts'>) => void;
}) {
	watch(
		opts.draftId,
		(id) => {
			if (id) opts.emitDraftId(id);
		},
		{ immediate: true }
	);

	const maximising = ref(false);
	async function handleMaximise() {
		if (maximising.value) return;
		maximising.value = true;
		try {
			const saved = await opts.flush();
			if (saved.ok && saved.result) opts.emitMaximise(saved.result);
		} finally {
			maximising.value = false;
		}
	}

	async function handleDiscard() {
		await opts.discard();
		opts.emitDiscarded();
	}

	const snapshot = () => ({
		draftId: opts.draftId.value ?? null,
		toAddresses: [...opts.toAddresses.value],
		hasContent: answerDraftHasContent(opts.bodyHtml.value, opts.attachmentCount()),
	});

	return { maximising, handleMaximise, handleDiscard, snapshot };
}
