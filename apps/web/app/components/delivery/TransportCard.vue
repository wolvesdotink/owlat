<script setup lang="ts">
/**
 * The one transport card that leads the Delivery hub.
 *
 * Sending has three first-class shapes (Owlat’s own mail server, Amazon SES, or
 * a generic SMTP relay), and until now an operator had to dig through the setup
 * sub-pages to learn which one is live and whether it’s healthy. This card makes
 * that the headline: current transport, ready/not-ready state, recent health,
 * and a single "Change transport" action. Provider-routing is demoted to an
 * "Advanced routing" link at the foot — the escape hatch, not the front door.
 *
 * Non-secret by construction: it reads `getTransportSummary` (member-safe, no
 * credentials, no env-presence map). Editing the transport lives on the
 * admin-gated config page this links to, so a member can see the state without
 * being able to change it.
 */
import { api } from '@owlat/api';
import { deriveTransportDisplay } from '~/utils/transportState';
import { healthChipClass, healthDotClass } from '~/utils/healthTone';
import { formatCompactRelativeTime } from '~/utils/formatters';

const {
	data: summary,
	isLoading,
	error,
} = useOrganizationQuery(api.delivery.status.getTransportSummary);

const display = computed(() => (summary.value ? deriveTransportDisplay(summary.value) : null));

const lastCheckedLabel = computed(() => {
	const at = summary.value?.health?.lastCheckedAt;
	return at ? formatCompactRelativeTime(at) : null;
});
</script>

<template>
	<UiCard padding="none" overflow="hidden">
		<!-- Loading -->
		<div v-if="isLoading" class="p-6 flex items-center gap-3 text-text-tertiary">
			<Icon name="lucide:loader-2" class="w-5 h-5 animate-spin" />
			<span class="text-sm">Checking how this instance sends…</span>
		</div>

		<!-- Error (e.g. transiently unavailable) -->
		<div v-else-if="error" class="p-6 flex items-start gap-3">
			<Icon name="lucide:alert-circle" class="w-5 h-5 text-warning mt-0.5 shrink-0" />
			<p class="text-sm text-text-secondary">
				Couldn’t load the sending transport just now. Reload to try again.
			</p>
		</div>

		<div v-else-if="display && summary" class="p-6 space-y-5">
			<!-- Headline: transport + state chips -->
			<div class="flex items-start justify-between gap-4">
				<div class="flex items-start gap-3 min-w-0">
					<UiIconBox icon="lucide:send" size="md" variant="brand" rounded="lg" />
					<div class="min-w-0">
						<p class="text-xs font-medium uppercase tracking-wide text-text-tertiary">
							Sending transport
						</p>
						<h2 class="text-lg font-semibold text-text-primary truncate">
							{{ display.label }}
						</h2>
						<p class="text-sm text-text-secondary mt-0.5">{{ display.description }}</p>
					</div>
				</div>
				<span
					class="px-2.5 py-1 rounded-full text-xs font-medium shrink-0"
					:class="
						display.configuredTone === 'success'
							? 'bg-success/10 text-success'
							: 'bg-error/10 text-error'
					"
				>
					{{ display.configuredLabel }}
				</span>
			</div>

			<!-- Health + last-checked line -->
			<div class="flex flex-wrap items-center gap-x-4 gap-y-2">
				<span
					class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium"
					:class="healthChipClass[display.healthTone]"
				>
					<span class="w-1.5 h-1.5 rounded-full" :class="healthDotClass[display.healthTone]" />
					{{ display.healthLabel }}
				</span>
				<span v-if="lastCheckedLabel" class="text-xs text-text-tertiary">
					Last send {{ lastCheckedLabel }}
				</span>
			</div>

			<!-- Not-ready nudge (plain language, no lecture) -->
			<p
				v-if="!display.isConfigured"
				class="flex items-start gap-2 text-sm text-text-secondary rounded-lg bg-bg-surface px-3 py-2"
			>
				<Icon name="lucide:info" class="w-4 h-4 text-warning mt-0.5 shrink-0" />
				<span>
					No usable transport is configured yet, so campaigns and replies can’t go out. Choose a
					transport to start sending.
				</span>
			</p>

			<!-- Advanced-routing-in-use note -->
			<p
				v-else-if="summary.advancedRoutingActive"
				class="flex items-start gap-2 text-sm text-text-secondary rounded-lg bg-bg-surface px-3 py-2"
			>
				<Icon name="lucide:route" class="w-4 h-4 text-text-tertiary mt-0.5 shrink-0" />
				<span>
					Advanced routing is overriding the instance transport for one or more message types.
				</span>
			</p>

			<!-- Actions -->
			<div class="flex flex-wrap items-center gap-3 pt-1">
				<NuxtLink to="/dashboard/delivery/config" class="btn btn-primary">
					<Icon name="lucide:settings-2" class="w-4 h-4" />
					{{ display.isConfigured ? 'Change transport' : 'Set up sending' }}
				</NuxtLink>
				<NuxtLink
					to="/dashboard/delivery/provider-routing"
					class="inline-flex items-center gap-1.5 text-sm font-medium text-text-secondary hover:text-brand transition-colors duration-(--motion-fast)"
				>
					<Icon name="lucide:route" class="w-4 h-4" />
					Advanced routing
				</NuxtLink>
			</div>
		</div>
	</UiCard>
</template>
