<script setup lang="ts">
/**
 * The People column's "Show N more" / "Show fewer" under a long group. With
 * nothing hidden and nothing to fold back it renders nothing.
 */
import { ChevronDownIcon } from '@coolicons/vue';

defineProps<{ hidden: number; canCollapse?: boolean; moreLabel?: string }>();
const emit = defineEmits<{ expand: []; collapse: [] }>();
const { t } = useI18n();
</script>

<template>
	<button
		v-if="hidden > 0 || canCollapse"
		type="button"
		class="mx-3.5 mt-1 flex w-[calc(100%-1.75rem)] items-center gap-2 rounded-lg px-2.5 py-2 text-left text-caption text-text-secondary hover:bg-bg-surface"
		:aria-expanded="hidden === 0"
		@click="hidden > 0 ? emit('expand') : emit('collapse')"
	>
		<ChevronDownIcon class="h-3.5 w-3.5" :class="hidden > 0 ? '' : 'rotate-180'" />
		{{
			hidden > 0
				? (moreLabel ??
					t('components.postbox.people.column.moreInGroup', { count: hidden }, hidden))
				: t('components.postbox.people.column.showFewer')
		}}
	</button>
</template>
