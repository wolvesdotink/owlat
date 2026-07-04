<script setup lang="ts">
const { target, isVisible } = useScrollReveal();

const highlights = [
	{
		icon: 'editor',
		label: 'Visual email builder',
		desc: 'Drag-and-drop blocks with live preview',
	},
	{
		icon: 'audience',
		label: 'Audience management',
		desc: 'Lists, segments, and custom properties',
	},
	{
		icon: 'campaign',
		label: 'Campaigns & A/B tests',
		desc: 'Schedule, test variants, track results',
	},
	{
		icon: 'api',
		label: 'Transactional API',
		desc: 'SDK and REST API for triggered sends',
	},
];
</script>

<template>
	<div ref="target" class="trust-section max-w-[1200px] mx-auto px-8 max-md:px-6 py-14" :class="{ visible: isVisible }">
		<div class="grid grid-cols-4 gap-6 max-lg:grid-cols-2 max-sm:grid-cols-1">
			<div
				v-for="(item, i) in highlights" :key="item.label"
				class="highlight-item group flex items-start gap-3.5 cursor-default"
				:style="{ '--i': i }"
			>
				<!-- Icon -->
				<div class="shrink-0 w-9 h-9 rounded-[10px] bg-brand-soft border border-brand-border/30 flex items-center justify-center transition-all duration-(--motion-moderate) group-hover:bg-brand/10 group-hover:border-brand/30 group-hover:scale-110">
					<!-- Editor -->
					<svg v-if="item.icon === 'editor'" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="text-brand">
						<rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18" /><path d="M9 21V9" />
					</svg>
					<!-- Audience -->
					<svg v-else-if="item.icon === 'audience'" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="text-brand">
						<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
					</svg>
					<!-- Campaign -->
					<svg v-else-if="item.icon === 'campaign'" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="text-brand">
						<path d="M12 20V10" /><path d="M18 20V4" /><path d="M6 20v-4" />
					</svg>
					<!-- API -->
					<svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="text-brand">
						<path d="m7 8-4 4 4 4" /><path d="m17 8 4 4-4 4" /><path d="m14 4-4 16" />
					</svg>
				</div>
				<div class="min-w-0">
					<span class="block text-[0.8125rem] font-semibold text-text-primary leading-tight mb-0.5 transition-colors duration-(--motion-moderate) group-hover:text-brand">
						{{ item.label }}
					</span>
					<span class="block text-[0.75rem] text-text-tertiary leading-snug">
						{{ item.desc }}
					</span>
				</div>
			</div>
		</div>
	</div>
</template>

<style scoped>
.highlight-item {
	opacity: 0;
	transform: translateY(12px);
	transition:
		opacity var(--motion-slow) var(--ease-spring),
		transform var(--motion-slow) var(--ease-spring);
	transition-delay: calc(0.05s + var(--i) * 0.08s);
}

.visible .highlight-item {
	opacity: 1;
	transform: none;
}
</style>
