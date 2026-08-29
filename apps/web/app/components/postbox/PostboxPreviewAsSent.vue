<script setup lang="ts">
/**
 * "Preview as sent" (plan idea 14).
 *
 * Three renderings of the draft as it will actually arrive: the HTML part, the
 * REAL `text/plain` alternative that ships beside it, and the same source
 * rendered dark. All three come from the one `renderDraftBodies` the outbound
 * dispatch action calls, so the preview cannot promise something the send does
 * not deliver.
 *
 * The plain-text pane is the point. It is the part nobody ever sees — terminal
 * clients, screen readers and "show original" all get it — and for a
 * block-built message it is routinely mangled. Showing it beside the HTML is
 * the only way a sender finds that out before the recipient does.
 *
 * Read-only: nothing here edits or sends. The panes render inside a sandboxed,
 * CSP-locked iframe, exactly like the reader's message body.
 */
import type { ComposerMode } from '~/composables/postbox/usePostboxCompose';
import type { EditorBlock } from '@owlat/email-builder';
import {
	SENT_PREVIEW_PANES,
	buildSentPreview,
	isEmptyPlainText,
	sentPreviewSrcdoc,
	type SentPreviewPaneId,
} from '~/utils/postboxSentPreview';

const props = defineProps<{
	open: boolean;
	subject: string;
	bodyHtml: string;
	bodyBlocks: EditorBlock[];
	composerMode: ComposerMode;
}>();

const emit = defineEmits<{ 'update:open': [value: boolean] }>();

const { t } = useI18n();

const activePane = ref<SentPreviewPaneId>('html');

// Derived only while the dialog is open: rendering a whole email document on
// every keystroke of a composer nobody is previewing would be pure waste.
const preview = computed(() => {
	if (!props.open) return null;
	return buildSentPreview({
		composerMode: props.composerMode,
		bodyHtml: props.bodyHtml,
		bodyBlocks: props.composerMode === 'full' ? JSON.stringify(props.bodyBlocks) : undefined,
		subject: props.subject,
	});
});

const srcdoc = computed(() => {
	const rendered = preview.value;
	if (!rendered) return '';
	return sentPreviewSrcdoc(activePane.value === 'dark' ? rendered.dark : rendered.html);
});

const plainText = computed(() => preview.value?.text ?? '');
const plainIsEmpty = computed(() => isEmptyPlainText(plainText.value));
</script>

<template>
	<UiModal
		:open="open"
		size="4xl"
		:title="t('components.postbox.postboxPreviewAsSent.title')"
		@update:open="emit('update:open', $event)"
	>
		<div class="space-y-3" data-testid="preview-as-sent">
			<p class="text-xs text-text-tertiary">
				{{ t('components.postbox.postboxPreviewAsSent.hint') }}
			</p>

			<div class="flex items-center gap-1" role="tablist">
				<button
					v-for="pane in SENT_PREVIEW_PANES"
					:key="pane.id"
					type="button"
					role="tab"
					class="rounded-full px-3 py-1 text-xs font-medium"
					:class="
						activePane === pane.id
							? 'bg-brand/10 text-brand'
							: 'text-text-secondary hover:bg-bg-surface'
					"
					:aria-selected="activePane === pane.id"
					@click="activePane = pane.id"
				>
					{{ t(pane.labelKey) }}
				</button>
				<!-- An AMP alternative only exists for designs with an interactive
				     block; say so rather than silently omitting a part that ships. -->
				<span
					v-if="preview?.hasAmp"
					class="ml-auto text-[11px] text-text-tertiary"
					:title="t('components.postbox.postboxPreviewAsSent.ampNoteTitle')"
				>
					{{ t('components.postbox.postboxPreviewAsSent.ampNote') }}
				</span>
			</div>

			<p class="text-xs text-text-secondary">
				{{ t(`components.postbox.postboxPreviewAsSent.captions.${activePane}`) }}
			</p>

			<pre
				v-if="activePane === 'plain'"
				class="max-h-[60vh] overflow-auto rounded border border-border-subtle bg-bg-surface p-3 text-xs whitespace-pre-wrap font-mono text-text-primary"
				data-testid="preview-plain-text"
				>{{
					plainIsEmpty ? t('components.postbox.postboxPreviewAsSent.emptyPlain') : plainText
				}}</pre>
			<!-- palette-ok: this is the recipient's paper, not our chrome. The email
			     ships its own palette, and the whole point of the two panes is that
			     one shows it on a light client and the other on a dark one — a
			     token that follows OUR theme would show neither honestly. -->
			<iframe
				v-else
				:srcdoc="srcdoc"
				sandbox=""
				referrerpolicy="no-referrer"
				class="w-full h-[60vh] rounded border border-border-subtle"
				:class="activePane === 'dark' ? 'bg-black' : 'bg-white'"
				:title="t(`components.postbox.postboxPreviewAsSent.panes.${activePane}`)"
			/>
		</div>
	</UiModal>
</template>
