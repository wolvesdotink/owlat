<script setup lang="ts">
// The contacts list header's Import dropdown: a CSV file or a connected
// integration. The page opens the matching modal.
import { ChevronDownIcon, LinkHorizontalIcon, TableIcon, UploadIcon } from '@coolicons/vue';

const emit = defineEmits<{ csv: []; integrations: [] }>();

const { t } = useI18n();

const isImportDropdownOpen = ref(false);
const importDropdownRef = ref<HTMLElement | null>(null);

useClickOutside(importDropdownRef, () => {
	isImportDropdownOpen.value = false;
});
</script>

<template>
	<div ref="importDropdownRef" class="relative">
		<UiButton
			variant="secondary"
			class="gap-2"
			@click.stop="isImportDropdownOpen = !isImportDropdownOpen"
		>
			<UploadIcon class="w-4 h-4" />
			{{ t('dashboard.audience.contacts.index.import') }}
			<ChevronDownIcon class="w-4 h-4" />
		</UiButton>
		<Transition
			enter-active-class="duration-(--motion-moderate) ease-spring"
			enter-from-class="opacity-0 translate-y-1"
			enter-to-class="opacity-100 translate-y-0"
			leave-active-class="duration-(--motion-moderate-exit) ease-exit"
			leave-from-class="opacity-100 translate-y-0"
			leave-to-class="opacity-0 translate-y-1"
		>
			<div
				v-if="isImportDropdownOpen"
				class="absolute right-0 mt-2 w-56 bg-bg-elevated border border-border-subtle rounded-xl shadow-lg z-20 py-1"
			>
				<button
					class="w-full px-3 py-2 text-left text-sm text-text-primary hover:bg-bg-surface flex items-center gap-3 transition-colors"
					@click="
						emit('csv');
						isImportDropdownOpen = false;
					"
				>
					<TableIcon class="w-4 h-4 text-brand" />
					<div>
						<p class="font-medium">
							{{ t('dashboard.audience.contacts.index.importMenu.csvTitle') }}
						</p>
						<p class="text-xs text-text-tertiary">
							{{ t('dashboard.audience.contacts.index.importMenu.csvDescription') }}
						</p>
					</div>
				</button>
				<div class="h-px bg-border-subtle my-1" />
				<button
					class="w-full px-3 py-2 text-left text-sm text-text-primary hover:bg-bg-surface flex items-center gap-3 transition-colors"
					@click="
						emit('integrations');
						isImportDropdownOpen = false;
					"
				>
					<LinkHorizontalIcon class="w-4 h-4 text-brand" />
					<div>
						<p class="font-medium">
							{{ t('dashboard.audience.contacts.index.importMenu.integrationsTitle') }}
						</p>
						<p class="text-xs text-text-tertiary">
							{{ t('dashboard.audience.contacts.index.importMenu.integrationsDescription') }}
						</p>
					</div>
				</button>
			</div>
		</Transition>
	</div>
</template>
