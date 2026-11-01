<script setup lang="ts">
import type { ReaderTranslationState } from '~/composables/postbox/usePostboxReaderTranslation';
import { TranslateIcon } from '@coolicons/vue';
import { SpinnerIcon } from '@owlat/ui/icons/SpinnerIcon';

/**
 * The reader's translation panel: the newest message somebody else wrote,
 * machine-translated into the app's language, above the conversation. Rendered as text (`v-text`,
 * never `v-html`), so a translation can never become markup, and the original
 * message below it is untouched.
 */
defineProps<{
	state: ReaderTranslationState;
	/** The target language's name, for the heading. */
	language: string;
}>();

const emit = defineEmits<{ close: []; retry: [] }>();

const { t } = useI18n();
</script>

<template>
	<section
		v-if="state.status !== 'idle'"
		class="rounded-lg border border-border-subtle bg-bg-elevated"
		data-testid="postbox-reader-translation"
		:aria-label="t('postbox.reader.translation.heading', { language })"
	>
		<div class="flex items-center gap-2 px-3 py-2">
			<TranslateIcon class="w-3.5 h-3.5 shrink-0 text-text-tertiary" />
			<p class="flex-1 text-xs font-medium text-text-secondary">
				{{ t('postbox.reader.translation.heading', { language }) }}
			</p>
			<button
				type="button"
				class="shrink-0 text-xs text-text-tertiary hover:text-text-primary"
				data-testid="postbox-translation-close"
				@click="emit('close')"
			>
				{{ t('common.close') }}
			</button>
		</div>
		<div class="px-3 pb-3" aria-live="polite" :aria-busy="state.status === 'loading'">
			<p
				v-if="state.status === 'loading'"
				class="flex items-center gap-1.5 text-xs text-text-tertiary"
			>
				<SpinnerIcon class="w-3.5 h-3.5" />
				{{ t('postbox.reader.translation.loading') }}
			</p>
			<div v-else-if="state.status === 'error'" class="flex items-center gap-2 text-xs">
				<p class="flex-1 text-text-secondary" role="status">{{ t(state.messageKey) }}</p>
				<UiButton variant="ghost" size="sm" @click="emit('retry')">
					{{ t('postbox.reader.translation.retry') }}
				</UiButton>
			</div>
			<template v-else-if="state.status === 'done'">
				<!-- v-text, not an indented interpolation: the paragraph keeps the
				     translation's own line breaks, and must not gain a leading space. -->
				<p
					class="whitespace-pre-wrap break-words text-sm text-text-primary"
					data-testid="postbox-translation-text"
					v-text="state.text"
				/>
				<p class="mt-2 text-xs text-text-tertiary">
					{{
						state.truncated
							? t('postbox.reader.translation.truncatedNote')
							: t('postbox.reader.translation.note')
					}}
				</p>
			</template>
		</div>
	</section>
</template>
