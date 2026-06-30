<script setup lang="ts">
const props = defineProps<{
	riskLevel: string;
	size?: 'sm' | 'md';
}>();

const badgeConfig = computed(() => {
	switch (props.riskLevel) {
		case 'low':
			return { label: 'Healthy', class: 'bg-success/10 text-success', icon: 'lucide:shield-check' };
		case 'medium':
			return { label: 'Fair', class: 'bg-warning/10 text-warning', icon: 'lucide:shield-alert' };
		case 'high':
			return { label: 'Poor', class: 'bg-orange-500/10 text-orange-500', icon: 'lucide:shield-alert' };
		case 'critical':
			return { label: 'Critical', class: 'bg-error/10 text-error', icon: 'lucide:shield-x' };
		default:
			return { label: 'Unknown', class: 'bg-bg-surface text-text-tertiary', icon: 'lucide:shield-question' };
	}
});

const sizeClass = computed(() => props.size === 'sm' ? 'text-xs px-2 py-0.5' : 'text-sm px-2.5 py-1');
</script>

<template>
	<span
		:class="[badgeConfig.class, sizeClass]"
		class="inline-flex items-center gap-1 rounded-full font-medium"
	>
		<Icon :name="badgeConfig.icon" class="w-3.5 h-3.5" />
		{{ badgeConfig.label }}
	</span>
</template>
