<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';
import type { useBulkSelection } from '~/composables/useBulkSelection';
import type { useContactBulkOperations } from '~/composables/useContactBulkOperations';
import {
	ChevronDownIcon,
	ChevronRightIcon,
	CloseIcon,
	DownloadIcon,
	ListMinusIcon,
	MoreHorizontalIcon,
	TagIcon,
	TrashIcon,
} from '@coolicons/vue';
import { SpinnerIcon } from '@owlat/ui/icons/SpinnerIcon';

// The contacts list's bulk bar, shown while contacts are selected: the count,
// "select all matching", the Actions menu (add to / remove from a topic,
// export, delete) and clear. The page owns the selection and the operations.
const props = defineProps<{
	bulkSelection: ReturnType<typeof useBulkSelection<Id<'contacts'>>>;
	bulkOps: ReturnType<typeof useContactBulkOperations>;
	topics: ReadonlyArray<{ _id: Id<'topics'>; name: string }> | null | undefined;
	canManage: boolean;
	totalCount: number;
	loadedCount: number;
}>();

const { t } = useI18n();

// Any click outside the Actions menu closes it and its submenus. The listener
// lives with this bar, which the page always renders, so a menu left open when
// the selection emptied is closed by the next click too.
const bulkActionDropdownRef = ref<HTMLElement | null>(null);

useClickOutside(bulkActionDropdownRef, () => {
	props.bulkOps.isBulkActionDropdownOpen.value = false;
	props.bulkOps.isAddToListDropdownOpen.value = false;
	props.bulkOps.isRemoveFromListDropdownOpen.value = false;
});
</script>

<template>
	<Transition
		enter-active-class="duration-(--motion-moderate) ease-spring"
		enter-from-class="opacity-0 scale-95"
		enter-to-class="opacity-100 scale-100"
		leave-active-class="duration-(--motion-moderate-exit) ease-exit"
		leave-from-class="opacity-100 scale-100"
		leave-to-class="opacity-0 scale-95"
	>
		<div v-if="canManage && bulkSelection.hasSelected.value" class="flex items-center gap-2">
			<span class="text-sm text-text-secondary">{{ bulkSelection.selectedCountText.value }}</span>

			<button
				v-if="!bulkSelection.isSelectAllMatching.value && totalCount > loadedCount"
				class="text-sm text-brand hover:underline"
				:disabled="bulkOps.isLoadingAllMatching.value"
				@click="bulkOps.selectAllMatchingFilter"
			>
				<SpinnerIcon v-if="bulkOps.isLoadingAllMatching.value" class="w-3 h-3 inline mr-1" />
				{{ t('dashboard.audience.contacts.index.selectAllMatching', { count: totalCount }) }}
			</button>

			<!-- Bulk Action Dropdown -->
			<div ref="bulkActionDropdownRef" class="relative">
				<UiButton
					variant="secondary"
					:disabled="bulkOps.isBulkOperationInProgress.value"
					@click.stop="
						bulkOps.isBulkActionDropdownOpen.value = !bulkOps.isBulkActionDropdownOpen.value
					"
				>
					<template #iconLeft><MoreHorizontalIcon class="w-4 h-4" /></template>
					{{ t('common.actions') }}
					<template #iconRight><ChevronDownIcon class="w-4 h-4" /></template>
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
						v-if="bulkOps.isBulkActionDropdownOpen.value"
						class="absolute right-0 mt-2 w-56 bg-bg-elevated border border-border-subtle rounded-xl shadow-lg z-20 py-1"
					>
						<!-- Add to Topic submenu -->
						<div class="relative">
							<button
								class="w-full px-3 py-2 text-left text-sm text-text-primary hover:bg-bg-surface flex items-center justify-between transition-colors"
								@click.stop="
									bulkOps.isAddToListDropdownOpen.value = !bulkOps.isAddToListDropdownOpen.value;
									bulkOps.isRemoveFromListDropdownOpen.value = false;
								"
							>
								<span class="flex items-center gap-2">
									<TagIcon class="w-4 h-4 text-brand" />
									{{ t('dashboard.audience.contacts.index.bulk.addToTopic') }}
								</span>
								<ChevronRightIcon class="w-4 h-4" />
							</button>

							<Transition
								enter-active-class="duration-(--motion-moderate) ease-spring"
								enter-from-class="opacity-0 -translate-x-1"
								enter-to-class="opacity-100 translate-x-0"
								leave-active-class="duration-(--motion-moderate-exit) ease-exit"
								leave-from-class="opacity-100 translate-x-0"
								leave-to-class="opacity-0 -translate-x-1"
							>
								<div
									v-if="bulkOps.isAddToListDropdownOpen.value"
									class="absolute left-full top-0 ml-1 w-48 bg-bg-elevated border border-border-subtle rounded-xl shadow-lg py-1 max-h-64 overflow-y-auto"
								>
									<template v-if="topics && topics.length > 0">
										<button
											v-for="list in topics"
											:key="list._id"
											class="w-full px-3 py-2 text-left text-sm text-text-primary hover:bg-bg-surface flex items-center gap-2 transition-colors"
											@click="bulkOps.handleBulkAddToList(list._id)"
										>
											<span class="truncate">{{ list.name }}</span>
										</button>
									</template>
									<div v-else class="px-3 py-2 text-sm text-text-tertiary">
										{{ t('dashboard.audience.contacts.index.bulk.noTopics') }}
									</div>
								</div>
							</Transition>
						</div>

						<!-- Remove from Topic submenu -->
						<div class="relative">
							<button
								class="w-full px-3 py-2 text-left text-sm text-text-primary hover:bg-bg-surface flex items-center justify-between transition-colors"
								@click.stop="
									bulkOps.isRemoveFromListDropdownOpen.value =
										!bulkOps.isRemoveFromListDropdownOpen.value;
									bulkOps.isAddToListDropdownOpen.value = false;
								"
							>
								<span class="flex items-center gap-2">
									<ListMinusIcon class="w-4 h-4 text-text-secondary" />
									{{ t('dashboard.audience.contacts.index.bulk.removeFromTopic') }}
								</span>
								<ChevronRightIcon class="w-4 h-4" />
							</button>

							<Transition
								enter-active-class="duration-(--motion-moderate) ease-spring"
								enter-from-class="opacity-0 -translate-x-1"
								enter-to-class="opacity-100 translate-x-0"
								leave-active-class="duration-(--motion-moderate-exit) ease-exit"
								leave-from-class="opacity-100 translate-x-0"
								leave-to-class="opacity-0 -translate-x-1"
							>
								<div
									v-if="bulkOps.isRemoveFromListDropdownOpen.value"
									class="absolute left-full top-0 ml-1 w-48 bg-bg-elevated border border-border-subtle rounded-xl shadow-lg py-1 max-h-64 overflow-y-auto"
								>
									<template v-if="topics && topics.length > 0">
										<button
											v-for="list in topics"
											:key="list._id"
											class="w-full px-3 py-2 text-left text-sm text-text-primary hover:bg-bg-surface flex items-center gap-2 transition-colors"
											@click="bulkOps.handleBulkRemoveFromList(list._id)"
										>
											<span class="truncate">{{ list.name }}</span>
										</button>
									</template>
									<div v-else class="px-3 py-2 text-sm text-text-tertiary">
										{{ t('dashboard.audience.contacts.index.bulk.noTopics') }}
									</div>
								</div>
							</Transition>
						</div>

						<div class="h-px bg-border-subtle my-1" />

						<button
							class="w-full px-3 py-2 text-left text-sm text-text-primary hover:bg-bg-surface flex items-center gap-2 transition-colors"
							@click="bulkOps.handleBulkExport"
						>
							<DownloadIcon class="w-4 h-4 text-text-secondary" />
							{{ t('dashboard.audience.contacts.index.bulk.exportSelected') }}
						</button>

						<div class="h-px bg-border-subtle my-1" />

						<button
							class="w-full px-3 py-2 text-left text-sm text-error hover:bg-error-subtle flex items-center gap-2 transition-colors"
							@click="bulkOps.openBulkDeleteModal"
						>
							<TrashIcon class="w-4 h-4" />
							{{ t('dashboard.audience.contacts.index.bulk.deleteSelected') }}
						</button>
					</div>
				</Transition>
			</div>

			<button
				class="p-1.5 rounded-lg text-text-tertiary hover:text-text-primary hover:bg-bg-surface-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
				@click="bulkSelection.clearSelection()"
				:aria-label="t('dashboard.audience.contacts.index.clearSelection')"
			>
				<CloseIcon class="w-4 h-4" />
			</button>
		</div>
	</Transition>
</template>
