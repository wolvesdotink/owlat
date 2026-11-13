<script setup lang="ts">
/**
 * The mailbox composer's body: the basic editor in Simple mode, the full email
 * builder in Designer mode, and a skeleton while a reopened draft's body loads.
 *
 * Mounted for the composer's whole life (only its branches switch), so the
 * designer's name and canvas colour survive a round trip through Simple mode.
 */
import type { EditorBlock } from '@owlat/email-builder';
import type { ComposerMode, ComposerSeed } from '~/composables/postbox/usePostboxCompose';
import type { BasicEditorHandle } from '~/composables/postbox/usePostboxComposerAnswerFrame';
import type { InlineImageSources } from '~/composables/postbox/usePostboxInlineImages';
import type {
	EditorSnippet,
	SnippetInsertOptions,
} from '~/composables/postbox/usePostboxSnippetPicker';
import { SIMPLE_BLOCK_TYPES } from '~/composables/postbox/postboxBlockTypes';
import UiSkeletonText from '@owlat/ui/components/ui/SkeletonText.vue';

const EmailBuilder = defineAsyncComponent(() =>
	import('@owlat/email-builder').then((m) => m.EmailBuilder)
);

const props = defineProps<{
	mailboxId: ComposerSeed['mailboxId'];
	composerMode: ComposerMode;
	/** Withheld until a reopened draft's body loads (see usePostboxCompose). */
	bodyPending: boolean;
	inlineImageSources: InlineImageSources;
	persistentToolbar: boolean;
	rewriteEnabled: boolean;
	embedImage: (file: File) => Promise<{ contentId: string; previewUrl: string } | null>;
	onRemoveEmbeddedImage: (contentId: string) => void;
	snippets?: EditorSnippet[];
	snippetInsert?: SnippetInsertOptions;
	/** Receives the basic editor while it is mounted, and null once it is not. */
	bindEditor: (editor: BasicEditorHandle | null) => void;
}>();

const bodyHtml = defineModel<string>('bodyHtml', { required: true });
const bodyBlocks = defineModel<EditorBlock[]>('bodyBlocks', { required: true });
const subject = defineModel<string>('subject', { required: true });

const { t, locale } = useI18n();
// Inline ghost-text autocomplete: gated by the `ai` flag AND the per-user
// toggle; the subject line is the bounded thread context for the prompt.
const { ghostSuggestionsEnabled } = usePostboxGhostGate();

const composerName = ref(
	t('components.postbox.postboxComposer.composerName', {
		timestamp: new Date().toLocaleString(locale.value),
	})
);
const backgroundColor = ref('#ffffff');

const builderConfig = computed(() => ({
	hideSubject: true,
	blockTypes: props.composerMode === 'simple' ? SIMPLE_BLOCK_TYPES : undefined,
}));

function bindEditorRef(editor: unknown) {
	props.bindEditor(editor as BasicEditorHandle | null);
}
</script>

<template>
	<div
		v-if="bodyPending"
		class="h-full px-4 py-3"
		role="group"
		aria-busy="true"
		:aria-label="t('components.postbox.postboxComposer.bodyLoading')"
	>
		<UiSkeletonText :lines="3" />
	</div>
	<PostboxBasicEditor
		v-else-if="composerMode === 'simple'"
		:key="inlineImageSources.scope"
		:ref="bindEditorRef"
		v-model="bodyHtml"
		:placeholder="t('components.postbox.postboxComposer.bodyPlaceholder')"
		:suggestions-enabled="ghostSuggestionsEnabled"
		:ghost-thread-context="subject"
		:rewrite-enabled="rewriteEnabled"
		:rewrite-mailbox-id="mailboxId"
		:persistent-toolbar="persistentToolbar"
		:emoji-shortcodes-enabled="true"
		:inline-images-enabled="true"
		:embed-image="embedImage"
		:on-remove-embedded-image="onRemoveEmbeddedImage"
		:inline-image-sources="inlineImageSources"
		:snippets="snippets"
		:snippet-insert="snippetInsert"
	/>
	<EmailBuilder
		v-else
		:blocks="bodyBlocks"
		:subject="subject"
		:name="composerName"
		:background-color="backgroundColor"
		:variables="[]"
		:config="builderConfig"
		class="h-full"
		@update:blocks="bodyBlocks = $event"
		@update:subject="subject = $event"
		@update:name="composerName = $event"
		@update:background-color="backgroundColor = $event"
	/>
</template>
