<script setup lang="ts">
/**
 * Shown on the ramp controls when cells exist but none is under the ramp yet:
 * the controls work, so this only says where to begin.
 */
import { DELIVERY_MIGRATE_ROUTE } from '~/utils/deliveryAdvancedEmpty';

const { t } = useI18n();
</script>

<template>
	<UiCard data-testid="ramp-controls-idle">
		<p class="text-sm text-text-secondary">
			{{ t('dashboard.admin.delivery.advanced.controls.idle.body') }}
		</p>
		<NuxtLink
			:to="DELIVERY_MIGRATE_ROUTE"
			class="mt-2 inline-flex items-center gap-2 text-sm text-brand hover:underline"
		>
			<Icon name="lucide:arrow-right-left" class="h-4 w-4" />
			{{ t('components.delivery.advancedEmptyState.migrateAction') }}
		</NuxtLink>
	</UiCard>
</template>
