<script setup lang="ts">
import { api } from '@owlat/api';
import { shouldShowSelfHostOnboarding } from '~/utils/onboarding';
import { normalizeDashboardUrl, resolveConvexDashboardUrl } from '~/utils/convexDashboard';

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
	() => (isSelfHost ? { userId: props.userId } : undefined)
);
const dismissed = computed(() => progress.value?.dismissed ?? false);
// Hide the banner once the instance can actually send (a delivery provider is
// configured with its required credentials present). `sendPathReady` is the
// same gate the send path itself uses (`isDeliveryConfigured`).
const canSend = computed(() => progress.value?.sendPathReady ?? false);

// Backups pointer (platform-admin only): a fresh install finishing with no
// backup plan is a real gap, so surface "Set up backups" here until the admin
// records the daily schedule. getBackupState is platform-admin gated on the
// server, so only subscribe once we know this viewer is an admin.
const { data: isPlatformAdmin } = useConvexQuery(
	api.platformAdmin.platformAdmin.isPlatformAdmin,
	() => ({})
);
const { data: backupState } = useConvexQuery(api.backups.getBackupState, () =>
	isPlatformAdmin.value === true ? {} : 'skip'
);
const showBackupsStep = computed(
	() => isPlatformAdmin.value === true && backupState.value?.isScheduleEnabled !== true
);

const { run: dismissOnboarding } = useBackendOperation(api.auth.onboarding.dismiss, {
	label: 'Dismiss onboarding',
});
async function dismiss() {
	await dismissOnboarding({ userId: props.userId });
}

// Convex dashboard URL. The dashboard is a separate service on port 6791 that,
// on a hardened self-host, is loopback-bound and reached over an SSH tunnel —
// it is NOT necessarily on the same public host as this app. So we resolve it
// in priority order: an operator-entered override (persisted locally) wins,
// then a build-time configured value (NUXT_PUBLIC_CONVEX_DASHBOARD_URL), then a
// best-effort port-swap guess that we clearly flag as a default. See
// `~/utils/convexDashboard`.
const { data: dashboardOverride, set: setDashboardOverride } = useLocalStorage<string>(
	'owlat:convexDashboardUrl',
	''
);
const resolvedDashboard = computed(() =>
	resolveConvexDashboardUrl({
		override: dashboardOverride.value,
		configured: config.public.convexDashboardUrl,
		currentHref: import.meta.client ? window.location.href : null,
	})
);
const convexDashboardUrl = computed(() => resolvedDashboard.value.url);
// A `derived` value is only a guess; surface the "customize" affordance so an
// operator behind a proxy can correct it.
const isDashboardGuess = computed(() => resolvedDashboard.value.source === 'derived');

// Inline editor for the dashboard URL override.
const isEditingDashboard = ref(false);
const dashboardDraft = ref('');
const dashboardDraftInvalid = computed(
	() =>
		dashboardDraft.value.trim().length > 0 && normalizeDashboardUrl(dashboardDraft.value) === null
);
function startEditingDashboard() {
	dashboardDraft.value = dashboardOverride.value || convexDashboardUrl.value;
	isEditingDashboard.value = true;
}
function saveDashboardUrl() {
	const normalized = normalizeDashboardUrl(dashboardDraft.value);
	// Empty draft clears the override (falls back to configured/derived).
	if (dashboardDraft.value.trim().length === 0) {
		setDashboardOverride('');
		isEditingDashboard.value = false;
		return;
	}
	if (normalized === null) return; // keep the editor open; field shows the error
	setDashboardOverride(normalized);
	isEditingDashboard.value = false;
}
function cancelEditingDashboard() {
	isEditingDashboard.value = false;
}

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
		enter-active-class="transition-all duration-(--motion-moderate) ease-spring"
		enter-from-class="opacity-0 -translate-y-2"
		enter-to-class="opacity-100 translate-y-0"
		leave-active-class="transition-all duration-(--motion-moderate-exit) ease-exit"
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
				<div
					class="shrink-0 w-10 h-10 rounded-xl bg-brand/15 flex items-center justify-center text-brand"
				>
					<Icon name="lucide:layers" class="w-5 h-5" />
				</div>

				<div class="flex-1 min-w-0">
					<h3 class="text-sm font-semibold text-text-primary mb-1">
						Welcome to your self-hosted Owlat instance
					</h3>
					<p class="text-[0.8125rem] text-text-secondary mb-4">
						You're running Owlat on your own infrastructure. Here are a few things to do before you
						send your first email:
					</p>

					<div class="grid grid-cols-1 md:grid-cols-2 gap-3">
						<!-- 1. Configure a sending provider (the actual pre-send requirement) -->
						<NuxtLink
							to="/dashboard/delivery/config"
							class="group flex flex-col gap-1 rounded-lg border border-border-default bg-bg-elevated p-3 hover:border-brand/40 hover:-translate-y-px transition-all"
						>
							<div class="flex items-center gap-2">
								<span
									class="w-5 h-5 rounded-full bg-brand/15 text-brand text-[0.6875rem] font-semibold flex items-center justify-center"
									>1</span
								>
								<span class="text-[0.8125rem] font-medium text-text-primary"
									>Configure a sending provider</span
								>
							</div>
							<span class="text-[0.75rem] text-text-tertiary pl-7"
								>A delivery provider + credentials — required to send any email</span
							>
							<span
								class="text-[0.75rem] text-brand font-medium group-hover:translate-x-0.5 transition-transform mt-1 pl-7"
							>
								Check delivery →
							</span>
						</NuxtLink>

						<!-- 2. Verify sending domain -->
						<NuxtLink
							to="/dashboard/delivery/domains"
							class="group flex flex-col gap-1 rounded-lg border border-border-default bg-bg-elevated p-3 hover:border-brand/40 hover:-translate-y-px transition-all"
						>
							<div class="flex items-center gap-2">
								<span
									class="w-5 h-5 rounded-full bg-brand/15 text-brand text-[0.6875rem] font-semibold flex items-center justify-center"
									>2</span
								>
								<span class="text-[0.8125rem] font-medium text-text-primary"
									>Verify a sending domain</span
								>
							</div>
							<span class="text-[0.75rem] text-text-tertiary pl-7"
								>SPF, DKIM, and DMARC — for deliverability</span
							>
							<span
								class="text-[0.75rem] text-brand font-medium group-hover:translate-x-0.5 transition-transform mt-1 pl-7"
							>
								Open Settings →
							</span>
						</NuxtLink>

						<!-- 3. Convex dashboard -->
						<div
							class="flex flex-col gap-1 rounded-lg border border-border-default bg-bg-elevated p-3"
						>
							<a
								:href="convexDashboardUrl"
								target="_blank"
								rel="noopener"
								class="group flex flex-col gap-1 hover:-translate-y-px transition-all"
							>
								<div class="flex items-center gap-2">
									<span
										class="w-5 h-5 rounded-full bg-brand/15 text-brand text-[0.6875rem] font-semibold flex items-center justify-center"
										>3</span
									>
									<span class="text-[0.8125rem] font-medium text-text-primary"
										>Open Convex dashboard</span
									>
								</div>
								<span class="text-[0.75rem] text-text-tertiary pl-7"
									>Inspect your database, functions, and logs</span
								>
								<span
									class="text-[0.75rem] text-brand font-medium group-hover:translate-x-0.5 transition-transform mt-1 pl-7"
								>
									Launch dashboard ↗
								</span>
							</a>

							<!-- Customize affordance: shown when the URL is only a derived guess. -->
							<div v-if="!isEditingDashboard" class="pl-7 mt-1">
								<p v-if="isDashboardGuess" class="text-[0.6875rem] text-text-tertiary">
									Default guess — the dashboard is often on a separate host or an SSH tunnel.
								</p>
								<button
									type="button"
									class="text-[0.6875rem] text-text-tertiary underline decoration-dotted hover:text-text-primary transition-colors"
									@click="startEditingDashboard"
								>
									{{
										isDashboardGuess
											? 'Customize if you are behind a proxy'
											: 'Customize dashboard URL'
									}}
								</button>
							</div>

							<div v-else class="pl-7 mt-1 flex flex-col gap-1.5">
								<input
									v-model="dashboardDraft"
									type="url"
									inputmode="url"
									placeholder="http://localhost:6791"
									aria-label="Convex dashboard URL"
									class="w-full rounded-md border bg-bg-surface px-2 py-1 text-[0.75rem] text-text-primary focus:outline-none focus:ring-1"
									:class="
										dashboardDraftInvalid
											? 'border-red-500 focus:ring-red-500'
											: 'border-border-default focus:ring-brand'
									"
									@keydown.enter.prevent="saveDashboardUrl"
									@keydown.esc.prevent="cancelEditingDashboard"
								/>
								<p v-if="dashboardDraftInvalid" class="text-[0.6875rem] text-red-500">
									Enter a valid http(s) URL, or leave empty to reset.
								</p>
								<div class="flex items-center gap-2">
									<button
										type="button"
										class="text-[0.6875rem] font-medium text-brand hover:underline disabled:opacity-40 disabled:cursor-not-allowed"
										:disabled="dashboardDraftInvalid"
										@click="saveDashboardUrl"
									>
										Save
									</button>
									<button
										type="button"
										class="text-[0.6875rem] text-text-tertiary hover:text-text-primary"
										@click="cancelEditingDashboard"
									>
										Cancel
									</button>
								</div>
							</div>
						</div>

						<!-- 4. Docs -->
						<a
							href="https://docs.owlat.app/developer/self-hosting"
							target="_blank"
							rel="noopener"
							class="group flex flex-col gap-1 rounded-lg border border-border-default bg-bg-elevated p-3 hover:border-brand/40 hover:-translate-y-px transition-all"
						>
							<div class="flex items-center gap-2">
								<span
									class="w-5 h-5 rounded-full bg-brand/15 text-brand text-[0.6875rem] font-semibold flex items-center justify-center"
									>4</span
								>
								<span class="text-[0.8125rem] font-medium text-text-primary"
									>Read the self-host docs</span
								>
							</div>
							<span class="text-[0.75rem] text-text-tertiary pl-7"
								>DNS, production config, maintenance</span
							>
							<span
								class="text-[0.75rem] text-brand font-medium group-hover:translate-x-0.5 transition-transform mt-1 pl-7"
							>
								Open docs ↗
							</span>
						</a>

						<!-- 5. Set up backups (admin only, until a schedule is recorded) -->
						<NuxtLink
							v-if="showBackupsStep"
							to="/dashboard/settings/backups"
							class="group flex flex-col gap-1 rounded-lg border border-border-default bg-bg-elevated p-3 hover:border-brand/40 hover:-translate-y-px transition-all"
						>
							<div class="flex items-center gap-2">
								<span
									class="w-5 h-5 rounded-full bg-brand/15 text-brand text-[0.6875rem] font-semibold flex items-center justify-center"
									>5</span
								>
								<span class="text-[0.8125rem] font-medium text-text-primary">Set up backups</span>
							</div>
							<span class="text-[0.75rem] text-text-tertiary pl-7"
								>Nothing is backed up until you turn it on — do this before you store real
								data</span
							>
							<span
								class="text-[0.75rem] text-brand font-medium group-hover:translate-x-0.5 transition-transform mt-1 pl-7"
							>
								Set up backups →
							</span>
						</NuxtLink>
					</div>
				</div>
			</div>
		</aside>
	</Transition>
</template>
