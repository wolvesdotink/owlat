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
	<!-- The label and the link are pinned to the first row; the value (the slot's
	     own `<dd>`, the first one) flows into the free cell between them from `sm`
	     up, and spans its own full-width row below them on a phone, where a 10rem
	     label column would leave the value one word wide. -->
	<div
		class="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 py-3 first:pt-0 last:pb-0 max-sm:[&>dd:first-of-type]:col-span-full sm:grid-cols-[10rem_minmax(0,1fr)_auto] sm:gap-y-4"
	>
		<dt class="row-start-1 col-start-1 text-sm font-medium text-text-secondary">{{ label }}</dt>
		<slot />
		<dd v-if="to" class="row-start-1 col-start-2 sm:col-start-3">
			<NuxtLink :to="to" class="link text-sm" :data-testid="linkTestid">{{
				action ?? t('common.edit')
			}}</NuxtLink>
		</dd>
	</div>
</template>
