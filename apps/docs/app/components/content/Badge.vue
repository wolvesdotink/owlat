<script setup lang="ts">
withDefaults(
	defineProps<{
		type?: 'info' | 'warning' | 'success' | 'danger';
	}>(),
	{ type: 'info' }
);
</script>

<template>
	<span class="badge" :class="`badge-${type}`">
		<slot />
	</span>
</template>

<style scoped>
.badge {
	display: inline-flex;
	align-items: center;
	padding: 2px 8px;
	font-size: 0.6875rem;
	font-weight: 550;
	text-transform: uppercase;
	letter-spacing: 0.04em;
	line-height: 1.5;
	border: 1px solid var(--color-border-default);
	border-radius: 9999px;
	vertical-align: middle;
	color: var(--color-text-secondary);
}

.badge-warning {
	color: var(--color-warning);
}

.badge-success {
	color: var(--color-success);
}

.badge-danger {
	color: var(--color-error);
}
</style>
