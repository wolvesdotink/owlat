<script setup lang="ts">
import { meterFillStyle } from '@owlat/ui/utils/meterFill';
import { SpinnerIcon } from '@owlat/ui/icons/SpinnerIcon';

// The contacts list's progress strip while a bulk operation runs.
defineProps<{
	active: boolean;
	type: string | null;
	/** Percent done, 0-100. */
	progress: number;
}>();

const { t } = useI18n();
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
		<div v-if="active" class="flex items-center gap-3 px-3 py-2 rounded-lg bg-bg-surface">
			<SpinnerIcon class="w-4 h-4 text-brand" />
			<span class="text-sm text-text-secondary">
				<template v-if="type === 'add'">{{
					t('dashboard.audience.contacts.index.bulk.progress.add')
				}}</template>
				<template v-else-if="type === 'remove'">{{
					t('dashboard.audience.contacts.index.bulk.progress.remove')
				}}</template>
				<template v-else-if="type === 'delete'">{{
					t('dashboard.audience.contacts.index.bulk.progress.delete')
				}}</template>
				<template v-else-if="type === 'export'">{{
					t('dashboard.audience.contacts.index.bulk.progress.export')
				}}</template>
			</span>
			<div class="w-20 h-1.5 bg-bg-elevated rounded-full overflow-hidden">
				<div
					class="ui-meter-fill h-full bg-brand transition-transform duration-(--motion-moderate)"
					:style="meterFillStyle(progress)"
				/>
			</div>
			<span class="text-xs text-text-tertiary">{{ progress }}%</span>
		</div>
	</Transition>
</template>
