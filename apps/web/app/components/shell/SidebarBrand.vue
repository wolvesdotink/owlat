<script setup lang="ts">
/**
 * The web sidebar's head: the Owlat mark with its alpha badge, and the close
 * button of the mobile drawer. Web only: on desktop the app identity lives in
 * the native window chrome and the titlebar, and the workspace (org) switcher
 * is the titlebar chip, so the sidebar carries navigation only.
 */
import { CloseIcon } from '@coolicons/vue';

defineProps<{ collapsed: boolean }>();
const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();
</script>

<template>
	<div class="h-16 flex items-center justify-between px-4 border-b border-border-subtle">
		<NuxtLink
			to="/dashboard"
			class="flex items-center gap-2"
			:class="{ 'justify-center w-full': collapsed }"
		>
			<div class="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0">
				<!-- The wordmark beside it names the link; folded, the mark has to. -->
				<img src="/owlat.svg" :alt="collapsed ? 'Owlat' : ''" class="w-8 h-8 dark:invert" />
			</div>
			<span v-if="!collapsed" class="text-lg font-semibold text-text-primary"> Owlat </span>
			<UiBadge v-if="!collapsed" size="sm">{{ t('shell.dashboard.alphaBadge') }}</UiBadge>
		</NuxtLink>

		<!-- Mobile close button -->
		<button
			v-if="!collapsed"
			type="button"
			class="lg:hidden flex size-11 items-center justify-center rounded-xl text-text-secondary hover:bg-bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
			@click="emit('close')"
			:aria-label="t('common.close')"
		>
			<CloseIcon class="w-5 h-5" />
		</button>
	</div>
</template>
