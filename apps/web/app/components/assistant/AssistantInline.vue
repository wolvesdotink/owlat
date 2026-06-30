<script setup lang="ts">
import type { Inline } from '~/utils/markdown';

defineProps<{ inlines: Inline[] }>();
</script>

<template>
	<template v-for="(part, i) in inlines" :key="i">
		<strong v-if="part.type === 'strong'" class="font-semibold">{{ part.value }}</strong>
		<em v-else-if="part.type === 'em'" class="italic">{{ part.value }}</em>
		<code
			v-else-if="part.type === 'code'"
			class="px-1 py-0.5 rounded bg-bg-surface border border-border-subtle text-[0.85em] font-mono"
			>{{ part.value }}</code
		>
		<a
			v-else-if="part.type === 'link'"
			:href="part.href"
			target="_blank"
			rel="noopener noreferrer"
			class="text-brand underline hover:no-underline"
			>{{ part.value }}</a
		>
		<template v-else>{{ part.value }}</template>
	</template>
</template>
