<script setup lang="ts">
/**
 * One row of the setup review summary: the label, the value (default slot, its
 * own `<dd>`), and a link back to the step that sets it.
 */
defineProps<{
	label: string;
	/** The wizard step that changes this value; no link when omitted. */
	to?: string;
	/** Link text; "Edit" when omitted. */
	action?: string;
	/** `data-testid` of the link. */
	linkTestid?: string;
}>();

const { t } = useI18n();
</script>

<template>
	<div class="grid grid-cols-[10rem_1fr_auto] gap-4 py-3 first:pt-0 last:pb-0">
		<dt class="text-sm font-medium text-text-secondary">{{ label }}</dt>
		<slot />
		<dd v-if="to">
			<NuxtLink :to="to" class="link text-sm" :data-testid="linkTestid">{{
				action ?? t('common.edit')
			}}</NuxtLink>
		</dd>
	</div>
</template>
