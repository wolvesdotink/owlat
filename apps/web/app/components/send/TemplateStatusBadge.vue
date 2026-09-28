<script setup lang="ts">
/** A template's status chip, shared by the marketing and transactional lists. */
import { templateStatusBadge, type TemplateStatus } from '~/utils/templateListSort';

const props = defineProps<{ status: TemplateStatus }>();

const { t } = useI18n();

const badge = computed(() => templateStatusBadge(props.status));
</script>

<template>
	<span
		:class="[
			'inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium whitespace-nowrap',
			badge.color,
		]"
	>
		<Icon :name="badge.icon" class="w-3 h-3" />
		{{ t(badge.label) }}
	</span>
</template>
