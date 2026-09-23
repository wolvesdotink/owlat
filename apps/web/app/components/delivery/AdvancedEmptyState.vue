<script setup lang="ts">
/**
 * The empty state every Delivery → Advanced screen shows before the ramp has
 * anything for it: what fills this screen, and where to start. The start is
 * always the same — Migrate from Mailchimp walks a relay and your own server
 * into sharing traffic — so the action is fixed here; each screen brings its
 * own sentence about what it will show.
 */
import { DELIVERY_MIGRATE_ROUTE } from '~/utils/deliveryAdvancedEmpty';

defineProps<{
	icon: string;
	title: string;
	description: string;
}>();

const { t } = useI18n();
</script>

<template>
	<UiCard data-testid="delivery-advanced-empty">
		<UiEmptyState :icon="icon" :title="title" :description="description">
			<template #action>
				<UiButton
					:to="DELIVERY_MIGRATE_ROUTE"
					variant="secondary"
					data-testid="delivery-advanced-empty-migrate"
				>
					<template #iconLeft><Icon name="lucide:arrow-right-left" class="h-4 w-4" /></template>
					{{ t('components.delivery.advancedEmptyState.migrateAction') }}
				</UiButton>
			</template>
		</UiEmptyState>
	</UiCard>
</template>
