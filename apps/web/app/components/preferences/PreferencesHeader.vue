<script setup lang="ts">
defineProps<{ hasMail: boolean }>();

const { t } = useI18n();
</script>

<template>
	<header class="mb-6 flex items-center justify-between">
		<div>
			<h1 class="text-2xl font-medium tracking-[-0.02em]">
				{{ t('components.preferences.preferencesHeader.title') }}
			</h1>
			<p class="text-text-secondary mt-1">
				{{ t('components.preferences.preferencesHeader.subtitle') }}
			</p>
		</div>
		<UiButton v-if="hasMail" @click="navigateTo('/dashboard/preferences/add-account')">
			<Icon name="lucide:plus" class="w-4 h-4 mr-1.5" />
			{{ t('components.preferences.preferencesHeader.addAccount') }}
		</UiButton>
	</header>
</template>
