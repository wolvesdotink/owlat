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
</script>

<template>
	<UiConfirmationDialog
		:open="!!pending"
		variant="danger"
		:title="
			pending ? t(`components.postbox.postboxFolderActions.confirmTitle.${pending.role}`) : ''
		"
		:description="
			pending
				? t(
						'components.postbox.postboxFolderActions.confirmBody',
						{ count: pending.count },
						pending.count
					)
				: ''
		"
		:confirm-text="
			pending ? t(`components.postbox.postboxFolderActions.empty.${pending.role}`) : ''
		"
		@update:open="
			(open: boolean) => {
				if (!open) bulk.cancelEmpty();
			}
		"
		@confirm="() => void bulk.confirmEmpty()"
	/>
</template>
