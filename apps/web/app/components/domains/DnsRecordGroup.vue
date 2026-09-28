<script setup lang="ts">
/**
 * One titled group of DNS records with its own "n of m found" count, so an
 * operator can tell which PART of the setup is incomplete before reading a
 * single record. The count is omitted until a check has run — "0 of 5 found"
 * on a domain nobody has verified yet would read as a failure.
 */
const props = defineProps<{
	/** Plain heading; the `title` slot replaces it when the heading needs markup. */
	title?: string;
	description?: string;
	verified: number;
	total: number;
	/** False until the first DNS check has produced a result. */
	checked: boolean;
}>();

const { t } = useI18n();

const complete = computed(() => props.total > 0 && props.verified === props.total);
</script>

<template>
	<section data-testid="dns-record-group">
		<div class="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
			<div class="min-w-0">
				<h5 class="text-xs font-medium text-text-tertiary uppercase tracking-wider">
					<slot name="title">{{ title }}</slot>
				</h5>
				<p v-if="description" class="mt-0.5 text-xs text-text-secondary">{{ description }}</p>
			</div>
			<span
				v-if="checked"
				:class="[
					'inline-flex shrink-0 items-center gap-1 text-xs font-medium',
					complete ? 'text-success' : 'text-text-secondary',
				]"
				data-testid="dns-record-group-count"
			>
				<Icon v-if="complete" name="lucide:check-circle-2" class="w-3.5 h-3.5" />
				{{ t('components.domains.dnsRecordGroup.count', { verified, total }) }}
			</span>
		</div>
		<div class="space-y-2">
			<slot />
		</div>
	</section>
</template>
