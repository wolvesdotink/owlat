<script setup lang="ts">
defineProps<{ hasMail: boolean }>();
</script>

<template>
	<header class="mb-6 flex items-center justify-between">
		<div>
			<h1 class="text-2xl font-semibold">Preferences</h1>
			<p class="text-text-secondary mt-1">Settings that affect only you.</p>
		</div>
		<UiButton v-if="hasMail" @click="navigateTo('/dashboard/preferences/add-account')">
			<Icon name="lucide:plus" class="w-4 h-4 mr-1.5" />
			Add account
		</UiButton>
	</header>
</template>
