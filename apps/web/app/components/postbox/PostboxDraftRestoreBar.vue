<script setup lang="ts">
/**
 * "Restore unsaved changes" (plan idea 7): the device mirror's offer.
 *
 * Shown when this device holds text for this draft that the server never
 * received (a tab that crashed, a failed save, a page left before its text was
 * saved). Two decisions, both final: Restore puts that text back in the
 * composer; Keep saved version drops it for good.
 *
 * Restore asks first when the draft may have changed since that text was
 * written (`restoreNeedsConfirmation`): restoring would replace what is saved
 * now. The dialog remembers the row it was confirmed against, and the mirror
 * re-checks it right before applying; if the row moved again meanwhile, the
 * question is asked again rather than answered for the person.
 *
 * Disabled while the draft is read-only (scheduled, being sent) and while a
 * Restore or Keep is already running.
 */
import type { ComposeMirror } from '~/composables/postbox/usePostboxComposeMirror';
import type { MirrorFields } from '~/utils/postboxDraftMirror';

const props = defineProps<{
	mirror: ComposeMirror;
	/** The draft cannot be edited right now (scheduled, being sent). */
	readOnly?: boolean;
}>();

const { t, locale } = useI18n();
const { showToast } = useToast();

const savedAtLabel = (savedAt: number) => new Date(savedAt).toLocaleTimeString(locale.value);

const confirmOpen = ref(false);
// The row the person is being asked about; Restore proceeds only against it.
let confirmingRow: MirrorFields | null = null;

const disabled = computed(() => props.readOnly === true || props.mirror.busy);

async function run(confirmed?: { row: MirrorFields | null }) {
	const outcome = await props.mirror.restore(confirmed);
	if (outcome.status === 'needs-confirmation') {
		confirmingRow = props.mirror.confirmationRow;
		confirmOpen.value = true;
		return;
	}
	confirmOpen.value = false;
	if (outcome.status === 'aborted' && outcome.reason === 'backup-failed') {
		showToast(t('components.postbox.postboxDraftRestoreBar.backupFailed'), 'error');
	} else if (outcome.status === 'aborted' && outcome.reason === 'unavailable') {
		showToast(t('components.postbox.postboxDraftRestoreBar.unavailable'), 'error');
	}
}

function onConfirm() {
	void run({ row: confirmingRow });
}
</script>

<template>
	<div
		v-if="mirror.offer"
		class="mx-3 mt-2 flex flex-wrap items-center gap-2 rounded border border-warning/40 bg-warning/10 px-3 py-2 text-xs"
		role="status"
		data-testid="draft-restore-bar"
		:aria-busy="mirror.busy"
	>
		<Icon name="lucide:history" class="w-4 h-4 text-warning flex-shrink-0" />
		<span class="text-text-secondary">
			{{
				t('components.postbox.postboxDraftRestoreBar.message', {
					time: savedAtLabel(mirror.offer.savedAt),
				})
			}}
		</span>
		<div class="ml-auto flex items-center gap-1.5">
			<UiButton size="sm" type="button" :disabled="disabled" @click="run()">
				<Icon
					v-if="mirror.busy"
					name="lucide:loader-2"
					class="w-3.5 h-3.5 mr-1 animate-spin motion-reduce:animate-none"
				/>
				{{ t('components.postbox.postboxDraftRestoreBar.restore') }}
			</UiButton>
			<UiButton size="sm" variant="ghost" type="button" :disabled="disabled" @click="mirror.keep()">
				{{ t('components.postbox.postboxDraftRestoreBar.dismiss') }}
			</UiButton>
		</div>
		<UiConfirmationDialog
			v-model:open="confirmOpen"
			variant="warning"
			:title="t('components.postbox.postboxDraftRestoreBar.confirmTitle')"
			:description="t('components.postbox.postboxDraftRestoreBar.confirmBody')"
			:confirm-text="t('components.postbox.postboxDraftRestoreBar.confirm')"
			:is-loading="mirror.busy"
			@confirm="onConfirm"
		/>
	</div>
</template>
