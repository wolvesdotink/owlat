<script setup lang="ts">
/**
 * The Delivery health page's domain table — one browsing table that folds
 * per-domain health, email-auth verification, and 30-day volume together. One
 * status chip per row; auth is a single roll-up line ("SPF · DKIM · DMARC ✓")
 * or the specific missing records with an inline "Fix →" link straight to the
 * domain setup panel. A browsing surface, not a doing-surface: no second focal
 * point, weight-based emphasis, terracotta reserved for the fix link.
 */
import { formatNumber } from '~/utils/formatters';

interface DomainRow {
	domain: string;
	status: 'registering' | 'pending' | 'verified' | 'failed';
	auth: { spf: boolean; dkim: boolean; dmarc: boolean };
	missing: string[];
	sent30d: number;
}

defineProps<{ rows: DomainRow[] }>();

const DOMAIN_SETUP_ROUTE = '/dashboard/delivery/domains';

const statusLabel: Record<DomainRow['status'], string> = {
	registering: 'Registering',
	pending: 'Not verified',
	verified: 'Verified',
	failed: 'Failed',
};

// Semantic dot/chip tone per status — success/warning/error tokens, never the
// terracotta brand fill (reserved for actions/links).
function statusTone(status: DomainRow['status']): 'success' | 'warning' | 'error' {
	if (status === 'verified') return 'success';
	if (status === 'failed') return 'error';
	return 'warning';
}

const dotClass: Record<'success' | 'warning' | 'error', string> = {
	success: 'bg-success',
	warning: 'bg-warning',
	error: 'bg-error',
};

const chipClass: Record<'success' | 'warning' | 'error', string> = {
	success: 'bg-success/10 text-success',
	warning: 'bg-warning/10 text-warning',
	error: 'bg-error/10 text-error',
};
</script>

<template>
	<UiCard>
		<div class="space-y-4">
			<div class="flex items-center gap-3">
				<UiIconBox icon="lucide:globe" size="lg" variant="brand" rounded="xl" />
				<div>
					<h2 class="text-lg font-semibold text-text-primary">Sending domains</h2>
					<p class="text-sm text-text-secondary">Verification and 30-day volume per domain</p>
				</div>
			</div>

			<UiEmptyState
				v-if="rows.length === 0"
				icon="lucide:globe"
				title="No sending domains yet"
				description="Add a domain and publish its DNS records to start sending from your own domain."
			>
				<template #action>
					<NuxtLink :to="DOMAIN_SETUP_ROUTE">
						<UiButton variant="secondary">
							<template #iconLeft>
								<Icon name="lucide:plus" class="w-4 h-4" />
							</template>
							Add a domain
						</UiButton>
					</NuxtLink>
				</template>
			</UiEmptyState>

			<div v-else class="divide-y divide-border-subtle">
				<div
					v-for="row in rows"
					:key="row.domain"
					class="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0"
				>
					<div class="min-w-0 flex-1">
						<div class="flex items-center gap-2">
							<span
								class="w-2 h-2 rounded-full shrink-0"
								:class="dotClass[statusTone(row.status)]"
								aria-hidden="true"
							/>
							<p
								class="truncate text-text-primary"
								:class="row.status === 'verified' ? 'font-medium' : 'font-[550]'"
							>
								{{ row.domain }}
							</p>
							<span
								class="text-xs px-2 py-0.5 rounded-full font-medium shrink-0"
								:class="chipClass[statusTone(row.status)]"
							>
								{{ statusLabel[row.status] }}
							</span>
						</div>
						<!-- Auth roll-up: one clean line when all pass, else name the gap + fix link -->
						<div class="mt-1 flex items-center gap-2 text-xs">
							<span v-if="row.missing.length === 0" class="text-success tabular-nums">
								SPF · DKIM · DMARC ✓
							</span>
							<template v-else>
								<span class="text-text-tertiary"> Missing {{ row.missing.join(', ') }} </span>
								<NuxtLink
									:to="DOMAIN_SETUP_ROUTE"
									class="inline-flex items-center gap-0.5 text-brand font-medium hover:underline focus-visible:underline focus-visible:outline-none rounded-sm transition-colors duration-(--motion-fast)"
								>
									Fix
									<Icon name="lucide:arrow-right" class="w-3 h-3" />
								</NuxtLink>
							</template>
						</div>
					</div>
					<p class="text-xs text-text-tertiary tabular-nums shrink-0 text-right">
						{{ formatNumber(row.sent30d) }} sent
						<span class="block text-[11px]">30d</span>
					</p>
				</div>
			</div>
		</div>
	</UiCard>
</template>
