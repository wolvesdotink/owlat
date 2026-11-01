<script setup lang="ts">
// Role Permissions Info — single source of truth (ROLE_DEFINITIONS), the
// same copy surfaced in the inline role menu.
import { useLocalized } from '~/composables/useLocalized';
import { ROLE_DEFINITIONS } from '~/utils/teamRoles';

const { t } = useI18n();
const localized = useLocalized();
</script>

<template>
	<UiCard>
		<h3 class="text-sm font-medium text-text-primary mb-4">
			{{ t('dashboard.admin.team.roles.title') }}
		</h3>
		<div class="grid gap-4 sm:grid-cols-3">
			<div v-for="def in ROLE_DEFINITIONS" :key="def.role" class="flex items-start gap-3">
				<UiIconBox
					:icon="def.icon"
					size="sm"
					:variant="def.role === 'editor' ? 'surface' : 'brand'"
					rounded="lg"
				/>
				<div>
					<p class="font-medium text-text-primary text-sm">{{ localized(def.label) }}</p>
					<p class="text-xs text-text-secondary mt-0.5">{{ localized(def.summary) }}</p>
					<p class="text-xs text-text-tertiary mt-0.5">{{ localized(def.detail) }}</p>
				</div>
			</div>
		</div>
	</UiCard>
</template>
