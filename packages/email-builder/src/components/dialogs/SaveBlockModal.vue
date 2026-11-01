<script setup lang="ts">
import { BookmarkIcon } from '@coolicons/vue';
import { SpinnerIcon } from '@owlat/ui/icons/SpinnerIcon';
import UiButton from '@owlat/ui/components/ui/Button.vue';
import UiModal from '@owlat/ui/components/ui/Modal.vue';
import { useBuilderI18n } from '../../i18n/useBuilderI18n';

const { t } = useBuilderI18n();

withDefaults(
	defineProps<{
		show: boolean;
		blockName: string;
		isSaving?: boolean;
	}>(),
	{
		isSaving: false,
	}
);

const emit = defineEmits<{
	(e: 'update:blockName', value: string): void;
	(e: 'close'): void;
	(e: 'save'): void;
}>();
</script>

<template>
	<UiModal :open="show" :title="t('builder.saveBlock.title')" @update:open="emit('close')">
		<div class="space-y-4">
			<div>
				<label class="block text-sm font-medium text-text-secondary mb-2" for="save-block-name">{{
					t('builder.saveBlock.name')
				}}</label>
				<input
					id="save-block-name"
					:value="blockName"
					type="text"
					class="w-full px-4 py-3 bg-white/[0.04] border border-border-subtle rounded-lg text-text-primary outline-none transition-[border-color,box-shadow] duration-(--motion-fast) focus:border-brand focus:ring-1 focus:ring-brand"
					:placeholder="t('builder.saveBlock.namePlaceholder')"
					@input="emit('update:blockName', ($event.target as HTMLInputElement).value)"
					@keyup.enter="emit('save')"
				/>
			</div>
		</div>

		<template #footer>
			<UiButton variant="secondary" @click="emit('close')">
				{{ t('builder.common.cancel') }}
			</UiButton>
			<UiButton
				variant="primary"
				:loading="isSaving"
				:disabled="!blockName.trim()"
				@click="emit('save')"
			>
				<template v-if="!isSaving" #iconLeft>
					<BookmarkIcon class="w-4 h-4" />
				</template>
				{{ t('builder.saveBlock.save') }}
			</UiButton>
		</template>
	</UiModal>
</template>
