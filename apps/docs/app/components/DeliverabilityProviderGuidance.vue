<script setup lang="ts">
import {
	DELIVERABILITY_DNS_GUIDANCE,
	DELIVERABILITY_VPS_GUIDANCE,
} from '@owlat/shared/deliverabilityProviderGuidance';

const props = defineProps<{ kind: 'vps' | 'dns' }>();
const guidance = computed(() =>
	Object.values(props.kind === 'vps' ? DELIVERABILITY_VPS_GUIDANCE : DELIVERABILITY_DNS_GUIDANCE)
);
</script>

<template>
	<div class="my-6 grid gap-4 md:grid-cols-3">
		<section
			v-for="provider in guidance"
			:key="provider.provider"
			class="rounded-lg border border-default p-4"
		>
			<h4 class="mt-0">{{ provider.providerLabel }}</h4>
			<p>{{ provider.summary }}</p>
			<ol>
				<li v-for="step in provider.steps" :key="step">{{ step }}</li>
			</ol>
			<a :href="provider.consoleHref" target="_blank" rel="noopener noreferrer">
				Open provider console
			</a>
		</section>
	</div>
</template>
