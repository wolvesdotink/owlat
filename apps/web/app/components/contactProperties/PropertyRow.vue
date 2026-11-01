<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';
import { MoreHorizontalIcon, PencilIcon, TrashIcon, type IconComponent } from '@coolicons/vue';
import { SpinnerIcon } from '@owlat/ui/icons/SpinnerIcon';

// One row of the contact properties admin list: type icon, label, type badge
// and key, then either the edit/delete menu or, while the property's values
// are still being deleted, the deletion progress (or a retry once it stopped).
defineProps<{
	property: {
		_id: Id<'contactProperties'>;
		key: string;
		label: string;
		deletion?: { status: string; valuesDeleted: number } | null;
	};
	typeIcon: IconComponent;
	/** The type's label, already translated. */
	typeLabel: string;
	pendingDeletion: boolean;
	retrying: boolean;
	/** Whether this row's menu is the one open. */
	menuOpen: boolean;
}>();

const emit = defineEmits<{
	'toggle-menu': [];
	edit: [];
	delete: [];
	retry: [];
}>();

const { t } = useI18n();
</script>

<template>
	<div class="px-6 py-4 flex items-center justify-between hover:bg-bg-surface/50 transition-colors">
		<div class="flex items-center gap-4" :class="{ 'opacity-60': pendingDeletion }">
			<!-- Type Icon -->
			<div class="p-2 rounded-lg bg-bg-surface flex items-center justify-center">
				<component :is="typeIcon" class="w-5 h-5 text-text-secondary" />
			</div>

			<!-- Property Info -->
			<div>
				<div class="flex items-center gap-2">
					<p class="font-medium text-text-primary">{{ property.label }}</p>
					<span
						class="px-2 py-0.5 rounded-full text-xs font-medium bg-bg-surface text-text-secondary border border-border-subtle"
					>
						{{ typeLabel }}
					</span>
				</div>
				<p class="text-sm text-text-tertiary font-mono">{{ property.key }}</p>
			</div>
		</div>

		<!-- Pending deletion: progress, or a retry once the job stopped -->
		<div
			v-if="pendingDeletion"
			class="flex items-center gap-3"
			data-testid="property-pending-deletion"
		>
			<template v-if="property.deletion?.status === 'failed'">
				<span class="text-sm text-error">
					{{ t('dashboard.admin.instance.properties.deletion.failed') }}
				</span>
				<UiButton variant="secondary" size="sm" :loading="retrying" @click="emit('retry')">
					{{ t('dashboard.admin.instance.properties.deletion.retry') }}
				</UiButton>
			</template>
			<template v-else>
				<div class="text-right">
					<p class="flex items-center justify-end gap-2 text-sm font-medium text-text-secondary">
						<SpinnerIcon class="w-4 h-4 text-text-tertiary" />
						{{ t('dashboard.admin.instance.properties.deletion.deleting') }}
					</p>
					<p v-if="property.deletion" class="text-xs text-text-tertiary">
						{{
							t(
								'dashboard.admin.instance.properties.deletion.progress',
								{ count: property.deletion.valuesDeleted },
								property.deletion.valuesDeleted
							)
						}}
					</p>
				</div>
			</template>
		</div>

		<!-- Actions -->
		<div v-else class="relative" data-property-dropdown>
			<UiButton variant="ghost" size="sm" @click.stop="emit('toggle-menu')">
				<MoreHorizontalIcon class="w-4 h-4" />
			</UiButton>

			<!-- Dropdown Menu -->
			<Transition name="dropdown">
				<div
					v-if="menuOpen"
					class="absolute right-0 mt-2 w-40 bg-bg-elevated border border-border-subtle rounded-xl shadow-lg z-10 py-1"
				>
					<button
						class="w-full px-4 py-2 text-left text-sm text-text-primary hover:bg-bg-surface flex items-center gap-2"
						@click="emit('edit')"
					>
						<PencilIcon class="w-4 h-4 text-text-tertiary" />
						{{ t('common.edit') }}
					</button>
					<button
						class="w-full px-4 py-2 text-left text-sm text-error hover:bg-bg-surface flex items-center gap-2"
						@click="emit('delete')"
					>
						<TrashIcon class="w-4 h-4" />
						{{ t('common.delete') }}
					</button>
				</div>
			</Transition>
		</div>
	</div>
</template>

<style scoped>
/* Dropdown transition */
.dropdown-enter-active,
.dropdown-leave-active {
	transition-property: opacity, transform;
	transition-duration: var(--motion-fast);
	transition-timing-function: var(--ease-spring);
}

.dropdown-enter-from,
.dropdown-leave-to {
	opacity: 0;
	transform: translateY(-0.5rem);
}
</style>
