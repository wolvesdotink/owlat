<script setup lang="ts">
import { reactive } from 'vue';
import { ChevronDown } from '@lucide/vue';

const expanded = reactive({ value: false });
</script>

<template>
	<div class="ep-settings-accordion">
		<button class="ep-settings-accordion-header" @click="expanded.value = !expanded.value">
			<span><slot name="title" /></span>
			<ChevronDown
				class="ep-settings-accordion-chevron"
				:class="{ 'ep-settings-accordion-open': expanded.value }"
			/>
		</button>
		<div v-if="expanded.value" class="ep-settings-accordion-body">
			<slot />
		</div>
	</div>
</template>

<style scoped>
/* Accordion */
.ep-settings-accordion {
	border-top: 1px solid var(--ep-border-subtle);
}

.ep-settings-accordion:first-of-type {
	margin-top: 12px;
}

.ep-settings-accordion-header {
	display: flex;
	justify-content: space-between;
	align-items: center;
	width: 100%;
	padding: 10px 0;
	background: transparent;
	border: none;
	color: var(--ep-text-secondary);
	font-size: 12px;
	font-weight: 500;
	cursor: pointer;
}

.ep-settings-accordion-header:hover {
	color: var(--ep-text-primary);
}

.ep-settings-accordion-chevron {
	width: 14px;
	height: 14px;
	color: var(--ep-text-tertiary);
	transition: transform var(--motion-moderate, 160ms)
		var(--ease-spring, cubic-bezier(0.25, 1, 0.5, 1));
}

.ep-settings-accordion-open {
	transform: rotate(180deg);
}

.ep-settings-accordion-body {
	display: flex;
	flex-direction: column;
	gap: 10px;
	padding-bottom: 12px;
}
</style>
