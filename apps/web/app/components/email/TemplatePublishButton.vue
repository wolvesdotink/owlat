<script setup lang="ts">
/**
 * The Email template editor's Publish / Unpublish toolbar button.
 *
 * Publish puts the row's stored HTML live, so it waits for unsaved edits to be
 * saved (and for there to be stored HTML at all). Unpublish stays available
 * with unsaved edits: it renders nothing, and a published template refuses
 * saves until it is unpublished, so holding it too would leave the edits with
 * no way to be saved.
 *
 * A held Publish is `aria-disabled`, not `disabled`. A `disabled` button leaves
 * the tab order and (through `.btn`'s `pointer-events: none`) never shows its
 * `title` either, so nobody learned why Publish was held. Focusable +
 * `aria-describedby` makes the reason arrive with the control; the click
 * handler is what keeps it inert.
 */
const props = defineProps<{
	isPublished: boolean;
	hasChanges: boolean;
	/** The row holds rendered HTML (it was saved from the editor at least once). */
	hasStoredHtml: boolean;
	loading: boolean;
}>();

const emit = defineEmits<{ toggle: [] }>();

const { t } = useI18n();

/** Publish is held until the edits are saved and the row has HTML to publish. */
const holdPublish = computed(
	() => !props.isPublished && (props.hasChanges || !props.hasStoredHtml)
);

/** Why Publish does nothing right now, or null when the control is live. */
const holdReason = computed(() => {
	if (!holdPublish.value) return null;
	return props.hasChanges
		? t('dashboard.send.emails.detail.edit.saveBeforePublishHint')
		: t('dashboard.send.emails.detail.edit.toasts.saveBeforePublish');
});
const holdReasonId = useId();

/**
 * The held look, with no press/hover feedback. The fill and label fade through
 * colour alpha, not `opacity`: `opacity` would fade the focus ring with them,
 * and this control is meant to be reached by keyboard. 50% matches `.btn`'s
 * `disabled:opacity-50`.
 */
const heldClass =
	'cursor-not-allowed active:scale-100 bg-surface-3/50 hover:bg-surface-3/50 text-text-primary/50';

function onToggle() {
	if (holdPublish.value) return;
	emit('toggle');
}
</script>

<template>
	<UiButton
		variant="secondary"
		size="sm"
		:loading="loading"
		:aria-disabled="holdPublish ? 'true' : undefined"
		:aria-describedby="holdPublish ? holdReasonId : undefined"
		:class="holdPublish ? heldClass : undefined"
		:title="holdReason ?? undefined"
		@click="onToggle"
	>
		<template #iconLeft>
			<Icon :name="isPublished ? 'lucide:undo-2' : 'lucide:send'" class="w-4 h-4" />
		</template>
		{{
			isPublished
				? t('dashboard.send.emails.detail.edit.unpublish')
				: t('dashboard.send.emails.detail.edit.publish')
		}}
	</UiButton>
	<!-- The held reason, for the control's accessible description. -->
	<span v-if="holdReason" :id="holdReasonId" class="sr-only">{{ holdReason }}</span>
</template>
