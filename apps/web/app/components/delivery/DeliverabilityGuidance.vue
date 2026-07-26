<script setup lang="ts">
import type { DeliverabilityChecklistItem } from '~/utils/deliverabilityCenter';

defineProps<{
	instructions: NonNullable<DeliverabilityChecklistItem['instructions']>;
	scopeKey: string;
}>();
</script>

<template>
	<div class="rounded-lg bg-bg-surface p-4">
		<p class="text-sm font-medium text-text-primary">
			<template v-if="instructions.provider !== 'generic'">
				We detected {{ instructions.providerLabel }}.
			</template>
			<template v-else> Provider detection unavailable. </template>
		</p>
		<p class="mt-1 text-sm text-text-secondary">{{ instructions.summary }}</p>
		<ol class="mt-3 space-y-2 text-sm text-text-secondary">
			<li
				v-for="(step, index) in instructions.steps"
				:key="`${scopeKey}:step:${index}`"
				class="flex gap-2"
			>
				<span
					class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand/10 text-xs font-semibold text-brand"
					>{{ index + 1 }}</span
				>
				<span>{{ step }}</span>
			</li>
		</ol>
		<a
			v-if="instructions.consoleHref"
			:href="instructions.consoleHref"
			target="_blank"
			rel="noopener noreferrer"
			class="mt-3 inline-flex items-center gap-1 text-sm font-medium text-brand hover:underline"
		>
			Open {{ instructions.providerLabel }}
			<Icon name="lucide:external-link" class="h-3.5 w-3.5" />
		</a>
	</div>
</template>
