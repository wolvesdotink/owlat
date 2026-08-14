<script setup lang="ts">
/**
 * Per-transport DNS guidance for the sending-domains page.
 *
 * How you make a domain "yours" for sending depends on the transport: Owlat’s
 * mail server publishes managed records, SES signs with its own DKIM identity
 * tokens, and an SMTP relay does SPF/DKIM on your behalf. This collapsed note
 * tells the operator, in plain language, what to check for the transport that’s
 * actually live — no new DNS machinery, just the right pointer. Reads the
 * member-safe `getTransportSummary` for the active kind.
 *
 * THE COPY AND THE DERIVATION LIVE IN `~/utils/transportDnsGuidance`, which
 * answers from the catalog entry's capabilities and falls back to a per-vendor
 * override where one exists. This file is the disclosure around it, and holds no
 * provider knowledge at all (the seams plan's D5).
 */
import { api } from '@owlat/api';
import { transportDnsGuidance } from '~/utils/transportDnsGuidance';

const { t } = useI18n();
const { data: summary } = useOrganizationQuery(api.delivery.status.getTransportSummary);

/**
 * The guidance table is module scope, so it never calls `useI18n`: it hands back
 * catalog keys (with parameters where it has any) and this render boundary is
 * what turns them into words.
 */
type GuidanceMessage = string | { key: string; params?: Record<string, unknown> };
const message = (value: GuidanceMessage): string =>
	typeof value === 'string' ? t(value) : t(value.key, value.params ?? {});

const guidance = computed(() => transportDnsGuidance(summary.value?.provider ?? undefined));

const open = ref(false);
</script>

<template>
	<UiCard v-if="guidance" padding="none" overflow="hidden" class="mb-6">
		<button
			type="button"
			class="w-full flex items-center justify-between gap-3 px-4 py-3 text-left transition-colors duration-(--motion-fast) hover:bg-bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
			:aria-expanded="open"
			@click="open = !open"
		>
			<span class="flex items-center gap-2.5 min-w-0">
				<Icon name="lucide:shield-check" class="w-4 h-4 text-text-tertiary shrink-0" />
				<span class="text-sm text-text-secondary truncate">
					<span class="font-medium text-text-primary">{{
						t('components.delivery.domainDnsGuidance.heading', {
							transport: message(guidance.label),
						})
					}}</span>
					— {{ message(guidance.lead) }}
				</span>
			</span>
			<Icon
				name="lucide:chevron-down"
				class="w-4 h-4 text-text-tertiary shrink-0 transition-transform duration-(--motion-fast)"
				:class="open ? 'rotate-180' : ''"
			/>
		</button>
		<div v-if="open" class="px-4 pb-4 pt-1 border-t border-border-subtle">
			<ul class="mt-3 space-y-2">
				<li
					v-for="(point, i) in guidance.points"
					:key="i"
					class="flex items-start gap-2 text-sm text-text-secondary"
				>
					<Icon name="lucide:check" class="w-4 h-4 text-success mt-0.5 shrink-0" />
					<span>{{ message(point) }}</span>
				</li>
			</ul>
		</div>
	</UiCard>
</template>
