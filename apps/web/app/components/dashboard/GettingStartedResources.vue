<script setup lang="ts">
import { normalizeDashboardUrl, resolveConvexDashboardUrl } from '~/utils/convexDashboard';

/**
 * Self-host resource links shown beneath the instance go-live steps in the
 * unified "Getting started" card: the Convex dashboard (with an inline,
 * operator-editable URL override) and the self-hosting docs. Carried over
 * verbatim from the retired SelfHostOnboardingBanner so no affordance is lost —
 * only the surface it lives in changed.
 */

const config = useRuntimeConfig();

// Convex dashboard URL. The dashboard is a separate service on port 6791 that,
// on a hardened self-host, is loopback-bound and reached over an SSH tunnel — it
// is NOT necessarily on the same public host as this app. Resolve it in priority
// order: an operator-entered override (persisted locally) wins, then a
// build-time value (NUXT_PUBLIC_CONVEX_DASHBOARD_URL), then a best-effort
// port-swap guess we clearly flag. See `~/utils/convexDashboard`.
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
	// Empty draft clears the override (falls back to configured/derived).
	if (dashboardDraft.value.trim().length === 0) {
		setDashboardOverride('');
		isEditingDashboard.value = false;
		return;
	}
	const normalized = normalizeDashboardUrl(dashboardDraft.value);
	if (normalized === null) return; // keep the editor open; field shows the error
	setDashboardOverride(normalized);
	isEditingDashboard.value = false;
}
function cancelEditingDashboard() {
	isEditingDashboard.value = false;
}
</script>

<template>
	<div class="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
		<!-- Convex dashboard -->
		<div class="flex flex-col gap-1 rounded-lg border border-border-default bg-bg-elevated p-3">
			<a
				:href="convexDashboardUrl"
				target="_blank"
				rel="noopener"
				class="group flex flex-col gap-1 transition-all hover:-translate-y-px"
			>
				<div class="flex items-center gap-2">
					<Icon name="lucide:layout-dashboard" class="h-4 w-4 text-text-tertiary" />
					<span class="text-sm font-medium text-text-primary">Open Convex dashboard</span>
				</div>
				<span class="pl-6 text-xs text-text-tertiary">
					Inspect your database, functions, and logs.
				</span>
				<span
					class="mt-1 pl-6 text-xs font-medium text-brand transition-transform group-hover:translate-x-0.5"
				>
					Launch dashboard ↗
				</span>
			</a>

			<!-- Customize affordance: shown when the URL is only a derived guess. -->
			<div v-if="!isEditingDashboard" class="mt-1 pl-6">
				<p v-if="isDashboardGuess" class="text-xs text-text-tertiary">
					Default guess — the dashboard is often on a separate host or an SSH tunnel.
				</p>
				<button
					type="button"
					class="text-xs text-text-tertiary underline decoration-dotted transition-colors hover:text-text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
					@click="startEditingDashboard"
				>
					{{ isDashboardGuess ? 'Customize if you are behind a proxy' : 'Customize dashboard URL' }}
				</button>
			</div>

			<div v-else class="mt-1 flex flex-col gap-1.5 pl-6">
				<input
					v-model="dashboardDraft"
					type="url"
					inputmode="url"
					placeholder="http://localhost:6791"
					aria-label="Convex dashboard URL"
					class="w-full rounded-md border bg-bg-surface px-2 py-1 text-xs text-text-primary focus:outline-none focus:ring-1"
					:class="
						dashboardDraftInvalid
							? 'border-error focus:ring-error'
							: 'border-border-default focus:ring-brand'
					"
					@keydown.enter.prevent="saveDashboardUrl"
					@keydown.esc.prevent="cancelEditingDashboard"
				/>
				<p v-if="dashboardDraftInvalid" class="text-xs text-error">
					Enter a valid http(s) URL, or leave empty to reset.
				</p>
				<div class="flex items-center gap-2">
					<button
						type="button"
						class="text-xs font-medium text-brand hover:underline disabled:cursor-not-allowed disabled:opacity-40"
						:disabled="dashboardDraftInvalid"
						@click="saveDashboardUrl"
					>
						Save
					</button>
					<button
						type="button"
						class="text-xs text-text-tertiary hover:text-text-primary"
						@click="cancelEditingDashboard"
					>
						Cancel
					</button>
				</div>
			</div>
		</div>

		<!-- Self-host docs -->
		<a
			href="https://docs.owlat.app/developer/self-hosting"
			target="_blank"
			rel="noopener"
			class="group flex flex-col gap-1 rounded-lg border border-border-default bg-bg-elevated p-3 transition-all hover:-translate-y-px hover:border-brand/40"
		>
			<div class="flex items-center gap-2">
				<Icon name="lucide:book-open" class="h-4 w-4 text-text-tertiary" />
				<span class="text-sm font-medium text-text-primary">Read the self-host docs</span>
			</div>
			<span class="pl-6 text-xs text-text-tertiary">DNS, production config, maintenance.</span>
			<span
				class="mt-1 pl-6 text-xs font-medium text-brand transition-transform group-hover:translate-x-0.5"
			>
				Open docs ↗
			</span>
		</a>
	</div>
</template>
