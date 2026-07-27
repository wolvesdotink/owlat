<script setup lang="ts">
 /**
 * The standing footnote under a domain's DNS records: propagation takes a
 * while, and verification is the operator's next action. Presentational only —
 * it takes no props, so it lives here purely to keep RecordRow.vue readable.
 */
</script>

<template>
	<div class="mt-4 p-4 bg-bg-surface rounded-xl border border-border-subtle">
		<p class="text-sm text-text-secondary">
			<strong class="text-text-primary">Note:</strong> DNS changes can take up to 48 hours to
			propagate. After adding these records, click "Verify Domain" to check the configuration.
			<a
				href="https://docs.owlat.app/developer/self-hosting-dns-email"
				target="_blank"
				rel="noopener noreferrer"
				class="inline-flex items-center gap-1 text-brand hover:underline ml-1"
			>
				Learn more
				<Icon name="lucide:external-link" class="w-3 h-3" />
			</a>
		</p>
	</div>
</template>
