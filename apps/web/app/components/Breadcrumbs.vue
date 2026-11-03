<script setup lang="ts">
/**
 * `hideShallow`: leave out a trail that is only the page itself (Home ›
 * Workbench). The page's own heading already says where you are; the trail
 * earns its row once there is somewhere to go back to.
 */
import { ChevronRightIcon, HouseIcon } from '@coolicons/vue';

const props = defineProps<{ hideShallow?: boolean }>();
const { t } = useI18n();
const { breadcrumbs } = useBreadcrumbs();
</script>

<template>
	<nav
		v-if="breadcrumbs.length > (props.hideShallow ? 1 : 0)"
		class="flex items-center gap-1 text-sm"
		:aria-label="t('components.breadcrumbs.label')"
	>
		<!-- Home link -->
		<NuxtLink
			to="/dashboard"
			class="flex items-center text-text-tertiary hover:text-text-primary transition-colors"
			:aria-label="t('components.breadcrumbs.home')"
		>
			<HouseIcon class="w-4 h-4" />
		</NuxtLink>

		<!-- Breadcrumb items -->
		<!-- Trail labels are message keys where they come from the route registries
		     (`lib/breadcrumbRoutes` / `lib/breadcrumbPatterns`, pure modules that
		     cannot call `useI18n`); a page-supplied dynamic crumb (a contact name,
		     a campaign title) is not a key and passes through unchanged. -->
		<template v-for="(item, index) in breadcrumbs" :key="index">
			<!-- Separator -->
			<ChevronRightIcon class="w-4 h-4 text-text-tertiary flex-shrink-0" />

			<!-- Breadcrumb item -->
			<NuxtLink
				v-if="item.href"
				:to="item.href"
				class="text-text-tertiary hover:text-text-primary transition-colors whitespace-nowrap"
			>
				{{ t(item.label) }}
			</NuxtLink>
			<span v-else class="text-text-primary font-medium whitespace-nowrap">
				{{ t(item.label) }}
			</span>
		</template>
	</nav>
</template>
