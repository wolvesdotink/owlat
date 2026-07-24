<script setup lang="ts">
import { api } from '@owlat/api';
import { unknownIpPoolWarning } from '~/utils/ipPool';
import {
	buildTransportOptions,
	isTransportAvailable,
	routeProvidersForWrite,
	seedRouteProviders,
	transportLabel,
} from '~/utils/providerRouting';
import {
	PROVIDER_ROUTE_MESSAGE_TYPES as MESSAGE_TYPES,
	PROVIDER_ROUTE_STRATEGIES as STRATEGIES,
	type ProviderRouteMessageType as MessageType,
	type ProviderRouteStrategy as Strategy,
} from '~/utils/providerRouteOptions';

useHead({ title: 'Provider Routing — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

const { hasActiveOrganization, isLoading: organizationLoading } = useOrganizationContext();

// ── Static option sets (mirror the backend literal unions) ──────────
// messageType: schema/delivery.ts providerRoutes; strategy: strategyValidator
// in providerRoutes.ts; providerType: SEND_PROVIDERS registry in
// lib/sendProviders/index.ts.
interface ProviderEntry {
	providerType: string;
	weight?: number;
	isEnabled: boolean;
}

interface DeliverabilityFallback {
	isEnabled: boolean;
	relayProviderType: string;
	isWarmupOverflowEnabled: boolean;
}

const strategyLabel = (strategy: string): string =>
	STRATEGIES.find((s) => s.value === strategy)?.label ?? strategy;

// ── Data ────────────────────────────────────────────────────────────
const { data: routesData, isLoading: routesLoading } = useOrganizationQuery(
	api.providerRoutes.listRoutes
);
const { data: transportCatalog, isLoading: catalogLoading } = useOrganizationQuery(
	api.providerRoutes.listTransportCatalog
);

// The IP-pool names the built-in MTA routes through — used to autocomplete the
// per-route override and warn on an unknown pool name (silently ignored by the
// MTA otherwise).
const { data: ipPools } = useOrganizationQuery(api.providerRoutes.listIpPools);

const isLoading = computed(
	() => organizationLoading.value || routesLoading.value || catalogLoading.value
);

const routeByType = computed(() => {
	const map = new Map<
		MessageType,
		{
			strategy: string;
			providers: ProviderEntry[];
			ipPool?: string;
			deliverabilityFallback?: DeliverabilityFallback;
		}
	>();
	for (const route of routesData.value ?? []) {
		map.set(route.messageType, {
			strategy: route.strategy,
			providers: route.providers,
			ipPool: route.ipPool,
			deliverabilityFallback: route.deliverabilityFallback,
		});
	}
	return map;
});

const transportOptions = computed(() =>
	buildTransportOptions(
		transportCatalog.value ?? [],
		(routesData.value ?? []).flatMap((route) => route.providers)
	)
);
const providerLabel = (providerType: string): string =>
	transportLabel(transportOptions.value, providerType);
const providerAvailable = (providerType: string): boolean =>
	isTransportAvailable(transportOptions.value, providerType);

// ── Mutations ───────────────────────────────────────────────────────
const { run: setRoute } = useBackendOperation(api.providerRoutes.setRoute, {
	label: 'Save provider route',
});
const { run: removeRoute } = useBackendOperation(api.providerRoutes.removeRoute, {
	label: 'Reset provider route',
});
const { showToast: showNotification } = useToast();

// ── Edit modal ──────────────────────────────────────────────────────
const editOpen = ref(false);
const editMessageType = ref<MessageType>('transactional');
const editStrategy = ref<Strategy>('single');
const editIpPool = ref('');
const editProviders = ref<ProviderEntry[]>([]);
const editFallbackEnabled = ref(false);
const editFallbackRelay = ref('ses');
const editWarmupOverflow = ref(false);
const isSaving = ref(false);
const editMessageTypeMeta = computed(() =>
	MESSAGE_TYPES.find((m) => m.value === editMessageType.value)
);

// Non-blocking warning when the typed IP pool isn't one the MTA understands.
const ipPoolWarning = computed(() => unknownIpPoolWarning(editIpPool.value, ipPools.value));

function startEdit(messageType: MessageType) {
	editMessageType.value = messageType;
	const existing = routeByType.value.get(messageType);

	if (existing) {
		editStrategy.value = existing.strategy as Strategy;
		editIpPool.value = existing.ipPool ?? '';
		editProviders.value = seedRouteProviders(transportOptions.value, existing.providers);
		editFallbackEnabled.value = existing.deliverabilityFallback?.isEnabled ?? false;
		editFallbackRelay.value = existing.deliverabilityFallback?.relayProviderType ?? 'ses';
		editWarmupOverflow.value = existing.deliverabilityFallback?.isWarmupOverflowEnabled ?? false;
	} else {
		// Seed every composed provider with the first available transport enabled.
		editStrategy.value = 'single';
		editIpPool.value = '';
		editProviders.value = seedRouteProviders(transportOptions.value);
		editFallbackEnabled.value = false;
		editFallbackRelay.value = 'ses';
		editWarmupOverflow.value = false;
	}
	editOpen.value = true;
}

function moveProvider(index: number, direction: -1 | 1) {
	const target = index + direction;
	if (target < 0 || target >= editProviders.value.length) return;
	const next = [...editProviders.value];
	const [moved] = next.splice(index, 1);
	if (!moved) return;
	next.splice(target, 0, moved);
	editProviders.value = next;
}

const enabledProviderCount = computed(() => editProviders.value.filter((p) => p.isEnabled).length);
const enabledRelays = computed(() =>
	editProviders.value.filter((provider) => provider.isEnabled && provider.providerType === 'ses')
);

async function handleSave() {
	if (!hasActiveOrganization.value) return;

	const enabled = editProviders.value.filter((p) => p.isEnabled);
	if (enabled.length === 0) {
		showNotification('Enable at least one provider before saving', 'error');
		return;
	}
	if (
		editFallbackEnabled.value &&
		(editFallbackRelay.value !== 'ses' ||
			!enabled.some((provider) => provider.providerType === 'mta') ||
			!enabledRelays.value.some((provider) => provider.providerType === editFallbackRelay.value))
	) {
		showNotification('Enable the owned MTA and the selected relay before saving', 'error');
		return;
	}

	isSaving.value = true;
	const result = await setRoute({
		messageType: editMessageType.value,
		strategy: editStrategy.value,
		// Preserve registered-provider order while removing retired kinds that the
		// fail-closed backend intentionally refuses to persist.
		providers: routeProvidersForWrite(
			transportOptions.value,
			editProviders.value,
			editStrategy.value
		),
		ipPool: editIpPool.value.trim() || undefined,
		deliverabilityFallback: editFallbackEnabled.value
			? {
					isEnabled: true,
					relayProviderType: editFallbackRelay.value,
					isWarmupOverflowEnabled: editWarmupOverflow.value,
				}
			: undefined,
	});
	isSaving.value = false;

	if (result === undefined) return;

	showNotification('Provider route saved');
	editOpen.value = false;
}

// ── Reset (remove) ──────────────────────────────────────────────────
const resetMessageType = ref<MessageType | null>(null);
const isResetting = ref(false);

async function handleReset() {
	if (!resetMessageType.value) return;
	isResetting.value = true;
	const result = await removeRoute({ messageType: resetMessageType.value });
	isResetting.value = false;
	if (result === undefined) return;
	showNotification('Provider route reset to the default');
	resetMessageType.value = null;
}
</script>

<template>
	<div class="p-6 lg:p-8">
		<!-- Header -->
		<div class="mb-6">
			<NuxtLink
				to="/dashboard/delivery/setup"
				class="inline-flex items-center gap-2 text-sm text-text-secondary hover:text-text-primary mb-4"
			>
				<Icon name="lucide:arrow-left" class="w-4 h-4" />
				Delivery setup
			</NuxtLink>
			<div class="flex items-center gap-3">
				<UiIconBox icon="lucide:route" size="lg" variant="brand" rounded="xl" />
				<div>
					<h1 class="text-2xl font-semibold text-text-primary">Provider Routing</h1>
					<p class="mt-1 text-text-secondary">
						Choose which email provider sends each message type, with failover and weighted
						workload-split across providers
					</p>
				</div>
			</div>
		</div>

		<!-- First-load skeleton (shaped like the route list) -->
		<div v-if="isLoading && !routesData" class="card overflow-hidden">
			<DashboardListSkeleton variant="card" leading :rows="4" />
		</div>

		<!-- No Organization State -->
		<div
			v-else-if="!hasActiveOrganization"
			class="card flex flex-col items-center justify-center py-16 text-center px-6"
		>
			<UiIconBox icon="lucide:route" size="xl" variant="surface" rounded="full" class="mb-4" />
			<p class="text-text-secondary font-medium">No workspace selected</p>
			<p class="text-sm text-text-tertiary mt-1 max-w-sm">
				Create or select a workspace to configure provider routing.
			</p>
		</div>

		<!-- Content -->
		<div v-else class="space-y-6">
			<!-- Info Card -->
			<div class="card p-6 bg-brand/5 border-brand/20">
				<div class="flex gap-4">
					<UiIconBox icon="lucide:info" size="sm" variant="brand" rounded="lg" />
					<div>
						<h3 class="font-medium text-text-primary mb-1">How routing works</h3>
						<p class="text-sm text-text-secondary">
							Each message type can use its own provider strategy. When no route is configured,
							sends fall back to the provider set by the
							<code class="px-1 py-0.5 rounded bg-bg-surface text-text-primary text-xs"
								>EMAIL_PROVIDER</code
							>
							environment variable. Configure a route to enable failover or to split traffic across
							multiple providers.
						</p>
					</div>
				</div>
			</div>

			<DeliveryRelayDomainStatus />

			<!-- Message-type route cards -->
			<div class="grid gap-4">
				<div v-for="type in MESSAGE_TYPES" :key="type.value" class="card p-6">
					<div class="flex items-start justify-between gap-4">
						<div class="flex items-start gap-4">
							<div class="p-3 rounded-lg bg-bg-surface flex items-center justify-center">
								<Icon :name="type.icon" class="w-6 h-6 text-text-secondary" />
							</div>
							<div>
								<h3 class="text-lg font-medium text-text-primary">{{ type.label }}</h3>
								<p class="text-sm text-text-secondary mt-0.5">{{ type.description }}</p>

								<!-- Configured route summary -->
								<DeliveryProviderRouteSummary
									v-if="routeByType.get(type.value)"
									:route="routeByType.get(type.value)!"
									:strategy-label="strategyLabel"
									:provider-label="providerLabel"
								/>

								<!-- Default fallback summary -->
								<p v-else class="mt-3 text-xs text-text-tertiary inline-flex items-center gap-1.5">
									<Icon name="lucide:server" class="w-3.5 h-3.5" />
									Using the default provider (EMAIL_PROVIDER)
								</p>
							</div>
						</div>

						<div class="flex items-center gap-2 shrink-0">
							<button
								v-if="routeByType.get(type.value)"
								class="btn btn-ghost p-2 text-error hover:bg-error/10"
								title="Reset to default"
								@click="resetMessageType = type.value"
							>
								<Icon name="lucide:rotate-ccw" class="w-4 h-4" />
							</button>
							<button class="btn btn-secondary gap-2" @click="startEdit(type.value)">
								<Icon name="lucide:settings-2" class="w-4 h-4" />
								{{ routeByType.get(type.value) ? 'Edit' : 'Configure' }}
							</button>
						</div>
					</div>
				</div>
			</div>
		</div>

		<!-- Edit Modal -->
		<UiModal v-model:open="editOpen" :title="`Route — ${editMessageTypeMeta?.label ?? ''}`">
			<div class="space-y-5">
				<!-- Strategy -->
				<div>
					<label for="route-strategy" class="label">Strategy</label>
					<select id="route-strategy" v-model="editStrategy" class="input">
						<option v-for="strategy in STRATEGIES" :key="strategy.value" :value="strategy.value">
							{{ strategy.label }}
						</option>
					</select>
					<p class="mt-1 text-xs text-text-tertiary">
						{{ STRATEGIES.find((s) => s.value === editStrategy)?.description }}
					</p>
				</div>

				<!-- Providers -->
				<div>
					<div class="flex items-center justify-between mb-2">
						<span class="label mb-0">Providers</span>
						<span class="text-xs text-text-tertiary">
							{{ editStrategy === 'priority_failover' ? 'Order = failover priority' : '' }}
						</span>
					</div>
					<div class="space-y-2">
						<div
							v-for="(provider, index) in editProviders"
							:key="provider.providerType"
							class="flex items-center gap-3 p-3 rounded-lg border border-border-subtle bg-bg-surface/40"
						>
							<!-- Reorder -->
							<div class="flex flex-col">
								<button
									type="button"
									class="p-0.5 text-text-tertiary hover:text-text-primary disabled:opacity-30"
									:disabled="index === 0"
									title="Move up"
									@click="moveProvider(index, -1)"
								>
									<Icon name="lucide:chevron-up" class="w-4 h-4" />
								</button>
								<button
									type="button"
									class="p-0.5 text-text-tertiary hover:text-text-primary disabled:opacity-30"
									:disabled="index === editProviders.length - 1"
									title="Move down"
									@click="moveProvider(index, 1)"
								>
									<Icon name="lucide:chevron-down" class="w-4 h-4" />
								</button>
							</div>

							<!-- Enabled toggle + name -->
							<label class="flex items-center gap-2 flex-1 cursor-pointer">
								<input
									v-model="provider.isEnabled"
									type="checkbox"
									class="rounded border-border-subtle text-brand focus:ring-brand"
									:disabled="!providerAvailable(provider.providerType)"
								/>
								<span class="text-sm font-medium text-text-primary">
									{{ providerLabel(provider.providerType) }}
								</span>
								<span v-if="!providerAvailable(provider.providerType)" class="text-xs text-warning">
									Unavailable
								</span>
							</label>

							<!-- Weight (workload_split only) -->
							<div v-if="editStrategy === 'workload_split'" class="flex items-center gap-1.5">
								<input
									v-model.number="provider.weight"
									type="number"
									min="0"
									max="100"
									class="input w-20 text-sm"
									:disabled="!provider.isEnabled"
								/>
								<span class="text-xs text-text-tertiary">wt</span>
							</div>
						</div>
					</div>
					<p v-if="enabledProviderCount === 0" class="mt-2 text-xs text-error">
						Enable at least one provider.
					</p>
				</div>

				<!-- IP pool -->
				<div>
					<label for="route-ip-pool" class="label">IP pool (optional)</label>
					<input
						id="route-ip-pool"
						v-model="editIpPool"
						type="text"
						placeholder="e.g. transactional"
						class="input"
						list="route-ip-pool-options"
						autocomplete="off"
					/>
					<datalist id="route-ip-pool-options">
						<option v-for="pool in ipPools ?? []" :key="pool" :value="pool" />
					</datalist>
					<p v-if="ipPoolWarning" class="mt-1 text-xs text-warning flex items-start gap-1.5">
						<Icon name="lucide:alert-triangle" class="w-3.5 h-3.5 shrink-0 mt-px" />
						<span>{{ ipPoolWarning }}</span>
					</p>
					<p class="mt-1 text-xs text-text-tertiary">
						Overrides the IP pool for the built-in MTA provider. Leave blank to use the provider's
						default.
					</p>
				</div>

				<DeliveryDeliverabilityFallbackEditor
					v-model:enabled="editFallbackEnabled"
					v-model:relay="editFallbackRelay"
					v-model:warmup-overflow="editWarmupOverflow"
					:message-type="editMessageType"
					:providers="editProviders"
					:provider-label="providerLabel"
				/>
			</div>

			<template #footer>
				<UiButton variant="secondary" :disabled="isSaving" @click="editOpen = false">
					Cancel
				</UiButton>
				<UiButton :loading="isSaving" :disabled="enabledProviderCount === 0" @click="handleSave">
					{{ isSaving ? 'Saving...' : 'Save Route' }}
				</UiButton>
			</template>
		</UiModal>

		<!-- Reset Confirmation -->
		<UiConfirmationDialog
			:open="!!resetMessageType"
			variant="danger"
			title="Reset Provider Route"
			description="This message type will revert to the default provider set by the EMAIL_PROVIDER environment variable."
			confirm-text="Reset to Default"
			:is-loading="isResetting"
			@update:open="
				(v: boolean) => {
					if (!v) resetMessageType = null;
				}
			"
			@confirm="handleReset"
		/>
	</div>
</template>
