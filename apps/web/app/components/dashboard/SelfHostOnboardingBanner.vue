<script setup lang="ts">
import { api } from '@owlat/api';
import { shouldShowSelfHostOnboarding } from '~/utils/onboarding';

const props = defineProps<{
	userId: string;
}>();

// Only show in self-hosted deployments.
// The banner auto-hides once the instance has a verified SEND PATH — a
// configured delivery provider with its credentials present. A verified domain
// alone is NOT enough: without a delivery provider every send fails, so domain
// verification was the wrong gate ("ready to send" was claimed while the
// instance couldn't send at all).
const config = useRuntimeConfig();
const isSelfHost = config.public.deploymentMode === 'selfhost';

// Onboarding state is INSTANCE-SCOPED on the server (single org per deployment):
// dismissal and send-path readiness both come from the same record the
// OnboardingChecklist reads, so dismissing here hides the surface for every
// admin/browser — not just this one (no per-user localStorage that disagrees
// with the shared progress).
const { data: progress, isLoading } = useOrganizationQuery(
	api.auth.onboarding.getWithActualProgress,
	() => (isSelfHost ? { userId: props.userId } : undefined),
);
const dismissed = computed(() => progress.value?.dismissed ?? false);
// Hide the banner once the instance can actually send (a delivery provider is
// configured with its required credentials present). `sendPathReady` is the
// same gate the send path itself uses (`isDeliveryConfigured`).
const canSend = computed(() => progress.value?.sendPathReady ?? false);

const { run: dismissOnboarding } = useBackendOperation(api.auth.onboarding.dismiss, {
	label: 'Dismiss onboarding',
});
async function dismiss() {
	await dismissOnboarding({ userId: props.userId });
}

// Convex dashboard URL — same host as web app, but port 6791.
// If the user opened the web app via a proxy hostname, they'll have to
// customize this. Good enough for 95% of installs.
const convexDashboardUrl = computed(() => {
	if (!import.meta.client) return '#';
	try {
		const url = new URL(window.location.href);
		url.port = '6791';
		url.pathname = '/';
		url.search = '';
		url.hash = '';
		return url.toString();
	} catch {
		return 'http://localhost:6791';
	}
});

const shouldShow = computed(() => {
	// Wait for the instance record before deciding, so an already-dismissed or
	// already-send-capable instance doesn't flash the banner on every load.
	if (isLoading.value) return false;
	return shouldShowSelfHostOnboarding({
		isSelfHost,
		dismissed: dismissed.value,
		canSend: canSend.value,
	});
});
</script>

<template>
	<Transition
		enter-active-class="transition-all duration-300 ease-out"
		enter-from-class="opacity-0 -translate-y-2"
		enter-to-class="opacity-100 translate-y-0"
		leave-active-class="transition-all duration-200 ease-in"
		leave-from-class="opacity-100 translate-y-0"
		leave-to-class="opacity-0 -translate-y-2"
	>
		<aside
			v-if="shouldShow"
			class="relative mb-6 rounded-xl border border-brand/30 bg-brand-soft/40 p-5 shadow-sm"
			role="region"
			aria-label="Self-hosted onboarding"
		>
			<!-- Dismiss -->
			<button
				type="button"
				class="absolute top-3 right-3 p-1.5 rounded-md text-text-tertiary hover:text-text-primary hover:bg-bg-surface/60 transition-colors"
				aria-label="Dismiss"
				@click="dismiss"
			>
				<Icon name="lucide:x" class="w-4 h-4" />
			</button>

			<div class="flex items-start gap-4">
				<div class="shrink-0 w-10 h-10 rounded-xl bg-brand/15 flex items-center justify-center text-brand">
					<Icon name="lucide:layers" class="w-5 h-5" />
				</div>

				<div class="flex-1 min-w-0">
					<h3 class="text-sm font-semibold text-text-primary mb-1">
						Welcome to your self-hosted Owlat instance
					</h3>
					<p class="text-[0.8125rem] text-text-secondary mb-4">
						You're running Owlat on your own infrastructure. Here are a few things to do before you send your first email:
					</p>

					<div class="grid grid-cols-1 md:grid-cols-2 gap-3">
						<!-- 1. Configure a sending provider (the actual pre-send requirement) -->
						<NuxtLink
							to="/dashboard/settings/delivery"
							class="group flex flex-col gap-1 rounded-lg border border-border-default bg-bg-elevated p-3 hover:border-brand/40 hover:-translate-y-px transition-all"
						>
							<div class="flex items-center gap-2">
								<span class="w-5 h-5 rounded-full bg-brand/15 text-brand text-[0.6875rem] font-semibold flex items-center justify-center">1</span>
								<span class="text-[0.8125rem] font-medium text-text-primary">Configure a sending provider</span>
							</div>
							<span class="text-[0.75rem] text-text-tertiary pl-7">A delivery provider + credentials — required to send any email</span>
							<span class="text-[0.75rem] text-brand font-medium group-hover:translate-x-0.5 transition-transform mt-1 pl-7">
								Check delivery →
							</span>
						</NuxtLink>

						<!-- 2. Verify sending domain -->
						<NuxtLink
							to="/dashboard/settings/domains"
							class="group flex flex-col gap-1 rounded-lg border border-border-default bg-bg-elevated p-3 hover:border-brand/40 hover:-translate-y-px transition-all"
						>
							<div class="flex items-center gap-2">
								<span class="w-5 h-5 rounded-full bg-brand/15 text-brand text-[0.6875rem] font-semibold flex items-center justify-center">2</span>
								<span class="text-[0.8125rem] font-medium text-text-primary">Verify a sending domain</span>
							</div>
							<span class="text-[0.75rem] text-text-tertiary pl-7">SPF, DKIM, and DMARC — for deliverability</span>
							<span class="text-[0.75rem] text-brand font-medium group-hover:translate-x-0.5 transition-transform mt-1 pl-7">
								Open Settings →
							</span>
						</NuxtLink>

						<!-- 3. Convex dashboard -->
						<a
							:href="convexDashboardUrl"
							target="_blank"
							rel="noopener"
							class="group flex flex-col gap-1 rounded-lg border border-border-default bg-bg-elevated p-3 hover:border-brand/40 hover:-translate-y-px transition-all"
						>
							<div class="flex items-center gap-2">
								<span class="w-5 h-5 rounded-full bg-brand/15 text-brand text-[0.6875rem] font-semibold flex items-center justify-center">3</span>
								<span class="text-[0.8125rem] font-medium text-text-primary">Open Convex dashboard</span>
							</div>
							<span class="text-[0.75rem] text-text-tertiary pl-7">Inspect your database, functions, and logs</span>
							<span class="text-[0.75rem] text-brand font-medium group-hover:translate-x-0.5 transition-transform mt-1 pl-7">
								Launch dashboard ↗
							</span>
						</a>

						<!-- 4. Docs -->
						<a
							href="https://docs.owlat.app/developer/self-hosting"
							target="_blank"
							rel="noopener"
							class="group flex flex-col gap-1 rounded-lg border border-border-default bg-bg-elevated p-3 hover:border-brand/40 hover:-translate-y-px transition-all"
						>
							<div class="flex items-center gap-2">
								<span class="w-5 h-5 rounded-full bg-brand/15 text-brand text-[0.6875rem] font-semibold flex items-center justify-center">4</span>
								<span class="text-[0.8125rem] font-medium text-text-primary">Read the self-host docs</span>
							</div>
							<span class="text-[0.75rem] text-text-tertiary pl-7">DNS, production config, maintenance</span>
							<span class="text-[0.75rem] text-brand font-medium group-hover:translate-x-0.5 transition-transform mt-1 pl-7">
								Open docs ↗
							</span>
						</a>
					</div>
				</div>
			</div>
		</aside>
	</Transition>
</template>
