<script setup lang="ts">
/**
 * The one confirmation for "Empty trash / spam", whichever entry point asked
 * (rail menu, list header, the bar above the folder, the palette). It names the
 * count the folder held when the person asked.
 */
import type { Id } from '@owlat/api/dataModel';

const props = defineProps<{ mailboxId: Id<'mailboxes'> }>();

const { t } = useI18n();
const bulk = usePostboxFolderBulk(computed(() => props.mailboxId));
const pending = bulk.pendingEmpty;
// The request clears the moment the dialog starts closing; the copy keeps the
// last one so the dialog does not go blank during its exit transition.
const shown = ref(pending.value);
watch(pending, (next) => {
	if (next) shown.value = next;
});
</script>

<template>
	<UiConfirmationDialog
		:open="!!pending"
		variant="danger"
		:title="shown ? t(`components.postbox.postboxFolderActions.confirmTitle.${shown.role}`) : ''"
		:description="
			shown
				? t(
						'components.postbox.postboxFolderActions.confirmBody',
						{ count: shown.count },
						shown.count
					)
				: ''
		"
		:confirm-text="shown ? t(`components.postbox.postboxFolderActions.empty.${shown.role}`) : ''"
		@update:open="
			(open: boolean) => {
				if (!open) bulk.cancelEmpty();
			}
		"
		@confirm="() => void bulk.confirmEmpty()"
	/>
</template>
