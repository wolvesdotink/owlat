<script setup lang="ts">
// The contacts list header's Import dropdown: a CSV file or a connected
// integration. The page opens the matching modal.
import {
	ChevronDownIcon,
	FileSpreadsheetIcon,
	LinkHorizontalIcon,
	UploadIcon,
} from '@coolicons/vue';

const emit = defineEmits<{ csv: []; integrations: [] }>();

const { t } = useI18n();

const isImportDropdownOpen = ref(false);
</script>

<template>
	<UiDropdownMenu v-model:open="isImportDropdownOpen" position="right">
		<template #trigger>
			<UiButton variant="secondary" class="gap-2">
				<UploadIcon class="w-4 h-4" />
				{{ t('dashboard.audience.contacts.index.import') }}
				<ChevronDownIcon class="w-4 h-4" />
			</UiButton>
		</template>
		<UiDropdownMenuItem @click="emit('csv')">
			<FileSpreadsheetIcon class="w-4 h-4 text-brand shrink-0" />
			<span class="min-w-0">
				<span class="block font-medium">
					{{ t('dashboard.audience.contacts.index.importMenu.csvTitle') }}
				</span>
				<span class="block text-xs text-text-tertiary">
					{{ t('dashboard.audience.contacts.index.importMenu.csvDescription') }}
				</span>
			</span>
		</UiDropdownMenuItem>
		<UiDropdownDivider />
		<UiDropdownMenuItem @click="emit('integrations')">
			<LinkHorizontalIcon class="w-4 h-4 text-brand shrink-0" />
			<span class="min-w-0">
				<span class="block font-medium">
					{{ t('dashboard.audience.contacts.index.importMenu.integrationsTitle') }}
				</span>
				<span class="block text-xs text-text-tertiary">
					{{ t('dashboard.audience.contacts.index.importMenu.integrationsDescription') }}
				</span>
			</span>
		</UiDropdownMenuItem>
	</UiDropdownMenu>
</template>
