<script setup lang="ts">
/**
 * Why the composer is not saving or sending right now (#895, #896).
 *
 *  - `loading`: a reopened draft's row has not arrived. Send waits for it,
 *    because until then the composer holds empty stand-ins for the saved
 *    recipients and body. Shown only once the wait is noticeable, so a normal
 *    reopen does not flash it.
 *  - `load_failed`: the row could not be read. Nothing is written over it;
 *    early edits stay on screen and merge in once a retry succeeds.
 *  - `missing`: the read answered that there is no row this member can open
 *    (deleted, or access lost). Nothing will load, so nothing is saved or sent;
 *    whatever is on screen can still be copied out.
 *  - `still_changing`: every save landed, but the message kept changing while
 *    Send (or the expand-to-popup) was saving it, so it stopped rather than
 *    use an older version. Autosave carries the rest on its normal debounce.
 *  - `not_sent` / `not_saved`: the latest changes did not save, so Send (or
 *    the expand-to-popup) stopped. The failing save has already toasted its
 *    own reason; this is what it cost and what is still safe.
 */
import { useDelayedLoading } from '@owlat/ui/composables/useDelayedLoading';
import type { ComposeDraftNotice } from '~/composables/postbox/usePostboxComposeSend';

const props = defineProps<{ notice: ComposeDraftNotice | null }>();
const emit = defineEmits<{ (e: 'retry'): void }>();

const { t } = useI18n();
const showLoading = useDelayedLoading(() => props.notice === 'loading');

const COPY_KEYS: Record<ComposeDraftNotice, string> = {
	loading: 'components.postbox.postboxComposerDraftNotice.loading',
	load_failed: 'components.postbox.postboxComposerDraftNotice.loadFailed',
	missing: 'components.postbox.postboxComposerDraftNotice.missing',
	not_sent: 'components.postbox.postboxComposerDraftNotice.notSent',
	not_saved: 'components.postbox.postboxComposerDraftNotice.notSaved',
	still_changing: 'components.postbox.postboxComposerDraftNotice.stillChanging',
};
const visible = computed(
	() => props.notice !== null && (props.notice !== 'loading' || showLoading.value)
);
const isError = computed(() => props.notice !== null && props.notice !== 'loading');

// The notice leads the composer's scroll region, which may be scrolled down to
// the body when a save or send is refused: bring the reason into view.
const root = ref<HTMLElement | null>(null);
watch(isError, async (error) => {
	if (!error) return;
	await nextTick();
	root.value?.scrollIntoView?.({ block: 'nearest' });
});
</script>

<template>
	<div
		v-if="visible && notice"
		ref="root"
		class="mx-3 mt-2 flex flex-wrap items-center gap-2 rounded border px-3 py-2 text-xs"
		:class="isError ? 'border-error/40 bg-error/10' : 'border-border-subtle bg-bg-surface'"
		:role="isError ? 'alert' : 'status'"
		data-testid="composer-draft-notice"
	>
		<Icon
			:name="isError ? 'lucide:alert-triangle' : 'lucide:loader-2'"
			class="w-4 h-4 flex-shrink-0"
			:class="
				isError ? 'text-error' : 'text-text-secondary animate-spin motion-reduce:animate-none'
			"
		/>
		<!-- One row: the sentence wraps inside its own column, and only when that
		     column would drop under 12rem does the action move to a line below. -->
		<span class="min-w-0 flex-1 basis-48 text-text-secondary">
			{{ t(COPY_KEYS[notice]) }}
		</span>
		<UiButton
			v-if="notice === 'load_failed'"
			class="ml-auto -my-1 flex-shrink-0"
			size="sm"
			variant="ghost"
			type="button"
			@click="emit('retry')"
		>
			{{ t('components.postbox.postboxComposerDraftNotice.tryAgain') }}
		</UiButton>
	</div>
</template>
