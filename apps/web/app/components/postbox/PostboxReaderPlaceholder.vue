<script setup lang="ts">
/**
 * The Postbox reader pane when there is no message to render. Three cases, in
 * this order:
 *   - the open message's read failed: the categorized error with Try again (#721);
 *   - the open message is gone for this viewer (`getMessage` answered `null`):
 *     "no longer available" with the way back to the folder (#1100);
 *   - nothing is open: "Select a message".
 */
const props = defineProps<{
	error: Error | null;
	notFound: boolean;
	/** The folder's display name, for "Back to Archive". */
	folderName: string;
}>();

const emit = defineEmits<{ retry: []; back: [] }>();

const { t } = useI18n();
</script>

<template>
	<UiQueryBoundary v-if="props.error" :error="props.error" @retry="emit('retry')" />
	<PostboxMessageNotFound v-else-if="props.notFound" class="pbx-reader-swap">
		<template #action>
			<UiButton variant="secondary" @click="emit('back')">
				{{ t('components.postbox.postboxMessageNotFound.backTo', { folder: props.folderName }) }}
			</UiButton>
		</template>
	</PostboxMessageNotFound>
	<div v-else class="pbx-reader-swap h-full flex items-center justify-center">
		<div class="text-center">
			<Icon name="lucide:mail-open" class="w-12 h-12 mx-auto text-text-tertiary" />
			<p class="mt-4 text-text-secondary">
				{{ t('components.postbox.postboxLayout.selectMessage') }}
			</p>
		</div>
	</div>
</template>
