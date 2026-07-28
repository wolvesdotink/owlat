<script setup lang="ts">
/**
 * The closing note under a domain's DNS guidance: what to expect after editing
 * a zone, and where to read more.
 *
 * Its own component because `RecordRow.vue` is a long template and this is a
 * self-contained, self-styled block with no dependency on the row's state — the
 * caller decides WHETHER to show it, this decides WHAT it says. Pinned by
 * `__tests__/dnsPropagationNote.test.ts`.
 */

/** Where "Learn more" points. Named so the test asserts one constant, not a literal. */
const DNS_DOCS_URL = 'https://docs.owlat.app/developer/self-hosting-dns-email';
</script>

<template>
	<div class="mt-4 p-4 bg-bg-surface rounded-xl border border-border-subtle">
		<p class="text-sm text-text-secondary">
			<strong class="text-text-primary">Note:</strong> DNS changes can take up to 48 hours to
			propagate. After adding these records, click "Verify Domain" to check the configuration.
			<a
				:href="DNS_DOCS_URL"
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
