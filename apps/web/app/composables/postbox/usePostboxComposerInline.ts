import type { Id } from '@owlat/api/dataModel';
import type { ComposerPromotePayload } from '~/composables/postbox/usePostboxComposerStack';

/**
 * Inline-variant behavior for the Postbox composer (the reader's in-place reply
 * box), factored out of `PostboxComposer.vue`:
 *   - promote-to-popup: flush the debounced autosave first (creating the draft
 *     row if needed) so the popup reopens the SAME draft id with no content
 *     loss, then hand the live field values across so it seeds instantly, and
 *   - focus-on-mount: focus the body editor when mounted inline (an inline box
 *     only mounts on an explicit user action, so this never steals focus on
 *     load). `focusBody` is returned so the reader's r/a keys can re-focus an
 *     already-open box.
 */
export function usePostboxComposerInline(opts: {
	inline: boolean;
	flush: () => Promise<Id<'mailDrafts'> | null>;
	snapshot: () => Omit<ComposerPromotePayload, 'draftId'>;
	emitPromote: (payload: ComposerPromotePayload) => void;
}) {
	const promoting = ref(false);
	const basicEditor = ref<{ focus: () => void } | null>(null);

	function focusBody() {
		basicEditor.value?.focus();
	}

	async function handlePromote() {
		if (promoting.value) return;
		promoting.value = true;
		try {
			const draftId = await opts.flush();
			opts.emitPromote({ draftId, ...opts.snapshot() });
		} finally {
			promoting.value = false;
		}
	}

	onMounted(() => {
		if (opts.inline) void nextTick(() => focusBody());
	});

	return { promoting, basicEditor, focusBody, handlePromote };
}
