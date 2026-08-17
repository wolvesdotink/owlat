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

const { t } = useI18n();
</script>

<template>
	<div class="mt-4 p-4 bg-bg-surface rounded-xl border border-border-subtle">
		<p class="text-sm text-text-secondary">
			<I18nT keypath="components.domains.dnsPropagationNote.body" tag="span" scope="global">
				<template #note>
					<strong class="text-text-primary">
						{{ t('components.domains.dnsPropagationNote.noteLabel') }}
					</strong>
				</template>
			</I18nT>
			<a
				:href="DNS_DOCS_URL"
				target="_blank"
				rel="noopener noreferrer"
				class="inline-flex items-center gap-1 text-brand hover:underline ml-1"
			>
				{{ t('common.learnMore') }}
				<Icon name="lucide:external-link" class="w-3 h-3" />
			</a>
		</p>
	</div>
</template>
