<script setup lang="ts">
const { breadcrumbs } = useBreadcrumbs();
</script>

<template>
	<nav
		v-if="breadcrumbs.length > 0"
		class="flex items-center gap-1 text-sm"
		aria-label="Breadcrumb"
	>
		<!-- Home link -->
		<NuxtLink
			to="/dashboard"
			class="flex items-center text-text-tertiary hover:text-text-primary transition-colors"
			aria-label="Home"
		>
			<Icon name="lucide:home" class="w-4 h-4" />
		</NuxtLink>

		<!-- Breadcrumb items -->
		<template v-for="(item, index) in breadcrumbs" :key="index">
			<!-- Separator -->
			<Icon name="lucide:chevron-right" class="w-4 h-4 text-text-tertiary flex-shrink-0" />

			<!-- Breadcrumb item -->
			<NuxtLink
				v-if="item.href"
				:to="item.href"
				class="text-text-tertiary hover:text-text-primary transition-colors whitespace-nowrap"
			>
				{{ item.label }}
			</NuxtLink>
			<span v-else class="text-text-primary font-medium whitespace-nowrap">
				{{ item.label }}
			</span>
		</template>
	</nav>
</template>
