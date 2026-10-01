/**
 * The Team inbox reply as the composer Answer mode's AI pieces work with
 * (`AnswerComposerApi`, the Postbox composer's counterpart): "Draft with AI"
 * streams its text into the reply, settles it, and can take it back out; the
 * catch-up card reads what was written for the ask ticks.
 *
 * The team reply is plain text with no draft row of its own (it answers an
 * inbound message), so the row, the follow-up reminder and the attachment
 * list are no-ops here: the ask session targets the thread itself, and the
 * files it finds reach the reply through `inbox.replyAttachments`.
 */
import type { Ref } from 'vue';
import type { AnswerComposerApi } from '~/composables/postbox/usePostboxComposerAnswerApi';

export function useTeamComposerAnswerApi(opts: {
	/** The editor's text. */
	body: Ref<string>;
	/** Mark the text as the person's (a new agent draft no longer re-seeds it). */
	touch: () => void;
	focus: () => void;
	addFiles?: (files: File[]) => void;
}): AnswerComposerApi {
	const aiDraft = ref<string | null>(null);
	/** What was written before the AI draft, for "Discard". */
	let before: string | null = null;

	function take(text: string) {
		if (before === null) before = opts.body.value;
		opts.touch();
		opts.body.value = text;
	}

	return {
		draftText: computed(() => opts.body.value.trim()),
		aiDraft,
		ensureDraftId: async () => null,
		streamAiDraft: take,
		async applyAiDraft(text) {
			take(text);
			aiDraft.value = text;
		},
		discardAiDraft() {
			opts.body.value = before ?? '';
			before = null;
			aiDraft.value = null;
		},
		setAttachments: () => {},
		async addFiles(files) {
			opts.addFiles?.(files);
		},
		setFollowUp: () => {},
		focusBody: opts.focus,
	};
}
