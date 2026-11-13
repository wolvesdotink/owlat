<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';
import type { useBulkSelection } from '~/composables/useBulkSelection';
import type { useContactBulkOperations } from '~/composables/useContactBulkOperations';
import {
	ChevronDownIcon,
	ChevronLeftIcon,
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
	/** Every matching contact, when the list knows it; null while more pages remain unread. */
	totalCount: number | null;
	loadedCount: number;
	/** More matching contacts exist than are loaded. */
	hasMore?: boolean;
}>();

const { t } = useI18n();

// "Select all matching" is offered whenever the selection can grow past the
// loaded rows. The number is named only when it is known.
const canSelectMore = computed(
	() => props.hasMore || (props.totalCount !== null && props.totalCount > props.loadedCount)
);

// The topic pickers are a second view inside the one Actions menu rather than
// flyouts beside it: a flyout off a right-aligned menu leaves the viewport on
// narrow screens.
const menuView = computed<'root' | 'add' | 'remove'>(() => {
	if (props.bulkOps.isAddToListDropdownOpen.value) return 'add';
	if (props.bulkOps.isRemoveFromListDropdownOpen.value) return 'remove';
	return 'root';
});

const menuContentRef = ref<HTMLElement | null>(null);

async function showMenuView(view: 'root' | 'add' | 'remove') {
	props.bulkOps.isAddToListDropdownOpen.value = view === 'add';
	props.bulkOps.isRemoveFromListDropdownOpen.value = view === 'remove';
	// The item that was pressed is gone, so focus moves to the new view's first item.
	await nextTick();
	menuContentRef.value?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
}

watch(
	() => props.bulkOps.isBulkActionDropdownOpen.value,
	(open) => {
		if (open) return;
		props.bulkOps.isAddToListDropdownOpen.value = false;
		props.bulkOps.isRemoveFromListDropdownOpen.value = false;
	}
);

// No menu while a bulk operation runs: its items would start a second one.
function setMenuOpen(open: boolean) {
	if (open && props.bulkOps.isBulkOperationInProgress.value) return;
	props.bulkOps.isBulkActionDropdownOpen.value = open;
}

// The bar unmounts with the selection; a menu left open would come back open.
watch(
	() => props.bulkSelection.hasSelected.value,
	(hasSelected) => {
		if (!hasSelected) props.bulkOps.isBulkActionDropdownOpen.value = false;
	}
);

const menuItemClass =
	'w-full px-3 py-2 text-left text-sm text-text-primary hover:bg-bg-surface focus-visible:bg-bg-surface focus-visible:outline-none flex items-center gap-2 transition-colors';
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
		<div
			v-if="canManage && bulkSelection.hasSelected.value"
			class="flex flex-wrap items-center gap-2"
		>
			<span class="text-sm text-text-secondary">{{ bulkSelection.selectedCountText.value }}</span>

			<button
				v-if="!bulkSelection.isSelectAllMatching.value && canSelectMore"
				type="button"
				class="text-sm text-brand hover:underline pointer-coarse:min-h-11"
				:disabled="bulkOps.isLoadingAllMatching.value"
				@click="bulkOps.selectAllMatchingFilter"
			>
				<SpinnerIcon v-if="bulkOps.isLoadingAllMatching.value" class="w-3 h-3 inline mr-1" />
				{{
					totalCount !== null && !hasMore
						? t('dashboard.audience.contacts.index.selectAllMatching', { count: totalCount })
						: t('dashboard.audience.contacts.index.selectAllMatchingUnknown')
				}}
			</button>

			<!-- Bulk Action Dropdown -->
			<UiDropdownMenu
				:open="bulkOps.isBulkActionDropdownOpen.value"
				position="right"
				@update:open="setMenuOpen"
			>
				<template #trigger>
					<UiButton variant="secondary" :disabled="bulkOps.isBulkOperationInProgress.value">
						<template #iconLeft><MoreHorizontalIcon class="w-4 h-4" /></template>
						{{ t('common.actions') }}
						<template #iconRight><ChevronDownIcon class="w-4 h-4" /></template>
					</UiButton>
				</template>

				<div ref="menuContentRef">
					<template v-if="menuView === 'root'">
						<!-- These two open a view, so they stop the click before the
						     menu's outside-click check sees an item that is already gone. -->
						<button
							type="button"
							role="menuitem"
							tabindex="-1"
							aria-haspopup="menu"
							:class="[menuItemClass, 'justify-between']"
							@click.stop="showMenuView('add')"
						>
							<span class="flex items-center gap-2">
								<TagIcon class="w-4 h-4 text-brand" />
								{{ t('dashboard.audience.contacts.index.bulk.addToTopic') }}
							</span>
							<ChevronRightIcon class="w-4 h-4" />
						</button>
						<button
							type="button"
							role="menuitem"
							tabindex="-1"
							aria-haspopup="menu"
							:class="[menuItemClass, 'justify-between']"
							@click.stop="showMenuView('remove')"
						>
							<span class="flex items-center gap-2">
								<ListMinusIcon class="w-4 h-4 text-text-secondary" />
								{{ t('dashboard.audience.contacts.index.bulk.removeFromTopic') }}
							</span>
							<ChevronRightIcon class="w-4 h-4" />
						</button>

						<UiDropdownDivider />

						<UiDropdownMenuItem :icon="DownloadIcon" @click="bulkOps.handleBulkExport">
							{{ t('dashboard.audience.contacts.index.bulk.exportSelected') }}
						</UiDropdownMenuItem>

						<UiDropdownDivider />

						<UiDropdownMenuItem :icon="TrashIcon" danger @click="bulkOps.openBulkDeleteModal">
							{{ t('dashboard.audience.contacts.index.bulk.deleteSelected') }}
						</UiDropdownMenuItem>
					</template>

					<template v-else>
						<button
							type="button"
							role="menuitem"
							tabindex="-1"
							:class="[menuItemClass, 'text-text-secondary']"
							@click.stop="showMenuView('root')"
						>
							<ChevronLeftIcon class="w-4 h-4" />
							{{
								menuView === 'add'
									? t('dashboard.audience.contacts.index.bulk.addToTopic')
									: t('dashboard.audience.contacts.index.bulk.removeFromTopic')
							}}
						</button>
						<UiDropdownDivider />
						<div class="max-h-64 overflow-y-auto">
							<template v-if="topics && topics.length > 0">
								<UiDropdownMenuItem
									v-for="list in topics"
									:key="list._id"
									:icon="TagIcon"
									@click="
										menuView === 'add'
											? bulkOps.handleBulkAddToList(list._id)
											: bulkOps.handleBulkRemoveFromList(list._id)
									"
								>
									<span class="truncate">{{ list.name }}</span>
								</UiDropdownMenuItem>
							</template>
							<p v-else class="px-3 py-2 text-sm text-text-tertiary">
								{{ t('dashboard.audience.contacts.index.bulk.noTopics') }}
							</p>
						</div>
					</template>
				</div>
			</UiDropdownMenu>

			<button
				type="button"
				class="inline-flex items-center justify-center p-1.5 pointer-coarse:size-11 rounded-lg text-text-tertiary hover:text-text-primary hover:bg-bg-surface-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
				:aria-label="t('dashboard.audience.contacts.index.clearSelection')"
				@click="bulkSelection.clearSelection()"
			>
				<CloseIcon class="w-4 h-4" />
			</button>
		</div>
	</Transition>
</template>
