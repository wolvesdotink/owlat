<script setup lang="ts">
const { target, isVisible } = useScrollReveal();

const highlights = [
	'Visual email builder',
	'Audience management',
	'Campaigns & A/B tests',
	'Transactional API',
];
</script>

<template>
	<div
		ref="target"
		class="trust-bar max-w-[1200px] mx-auto px-8 max-md:px-6 py-10"
		:class="{ visible: isVisible }"
	>
		<ul
			class="flex flex-wrap items-center gap-x-8 gap-y-3 m-0 p-0 list-none border-t border-border-subtle pt-8"
		>
			<li
				v-for="item in highlights"
				:key="item"
				class="text-[0.8125rem] text-text-secondary leading-tight"
			>
				{{ item }}
			</li>
		</ul>
	</div>
</template>

<style scoped>
.trust-bar {
	opacity: 0;
	transform: translateY(8px);
	transition:
		opacity var(--motion-moderate) var(--ease-spring),
		transform var(--motion-moderate) var(--ease-spring);
}

.trust-bar.visible {
	opacity: 1;
	transform: none;
}
</style>
