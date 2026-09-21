<script setup lang="ts">
/**
 * "Restore unsaved changes" (plan idea 7).
 *
 * Shown only when the on-device mirror holds keystrokes the server row never
 * received — a tab that crashed, a browser killed mid-sentence, a device that
 * dropped off the network between autosaves. The reconcile that decides this
 * lives in `~/utils/postboxDraftMirror`; by the time the bar renders, the
 * answer is already "yes, something was lost".
 *
 * Two buttons, both final: Restore puts the mirrored text back in the composer
 * (autosave takes it from there), Keep saved version throws the mirror away for
 * good so the same superseded text is never offered again. There is no third
 * "decide later" state — the bar sits above a composer the user is about to
 * type into, and an offer that survives editing would be offering to overwrite
 * the very edits it interrupted.
 */
import type { DraftMirrorEntry } from '~/utils/postboxDraftMirror';

defineProps<{
	/** The recovered mirror, or null when there is nothing to offer. */
	entry: DraftMirrorEntry | null;
}>();

const emit = defineEmits<{
	(e: 'restore'): void;
	(e: 'dismiss'): void;
}>();

const { t, locale } = useI18n();

const savedAtLabel = (savedAt: number) => new Date(savedAt).toLocaleTimeString(locale.value);
</script>

<template>
	<div
		v-if="entry"
		class="mx-3 mt-2 flex flex-wrap items-center gap-2 rounded border border-warning/40 bg-warning/10 px-3 py-2 text-xs"
		role="status"
		data-testid="draft-restore-bar"
	>
		<Icon name="lucide:history" class="w-4 h-4 text-warning flex-shrink-0" />
		<span class="text-text-secondary">
			{{
				t('components.postbox.postboxDraftRestoreBar.message', {
					time: savedAtLabel(entry.savedAt),
				})
			}}
		</span>
		<div class="ml-auto flex items-center gap-1.5">
			<UiButton size="sm" type="button" @click="emit('restore')">
				{{ t('components.postbox.postboxDraftRestoreBar.restore') }}
			</UiButton>
			<UiButton size="sm" variant="ghost" type="button" @click="emit('dismiss')">
				{{ t('components.postbox.postboxDraftRestoreBar.dismiss') }}
			</UiButton>
		</div>
	</div>
</template>
