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
				<img src="/owlat.svg" alt="Owlat" class="w-8 h-8 dark:invert" />
			</div>
			<span v-if="!collapsed" class="text-lg font-semibold text-text-primary"> Owlat </span>
			<UiBadge v-if="!collapsed" size="sm">{{ t('shell.dashboard.alphaBadge') }}</UiBadge>
		</NuxtLink>

		<!-- Mobile close button -->
		<button
			v-if="!collapsed"
			class="lg:hidden p-2 text-text-secondary hover:text-text-primary"
			@click="emit('close')"
			:aria-label="t('common.close')"
		>
			<CloseIcon class="w-5 h-5" />
		</button>
	</div>
</template>
