<script setup lang="ts">
import { api } from '@owlat/api';
import { unknownIpPoolWarning } from '~/utils/ipPool';
import {
	buildTransportOptions,
	fallbackRelayIssue,
	isTransportAvailable,
	routeProvidersForWrite,
	seedRouteProviders,
	transportLabel,
} from '~/utils/providerRouting';
import {
	isControllerOwnedStrategy,
	PROVIDER_ROUTE_MESSAGE_TYPES as MESSAGE_TYPES,
	PROVIDER_ROUTE_STRATEGIES as STRATEGIES,
	strategyLabelFor as strategyLabel,
	type ProviderRouteMessageType as MessageType,
	type ProviderRouteStrategy as Strategy,
} from '~/utils/providerRouteOptions';

const { t } = useI18n();

/**
 * `utils/providerRouteOptions`, `utils/providerRouting` and `utils/ipPool` are
 * module-scope definition sets whose labels and refusal sentences carry i18n keys
 * rather than sentences (the registry convention); a plain string is still
 * accepted so a value with nothing to translate reads as itself.
 */
type LocalizedText = string | { key: string; params?: Record<string, unknown> };
function localized(value: LocalizedText): string {
	return typeof value === 'string' ? t(value) : t(value.key, value.params ?? {});
}

useHead({ title: () => t('dashboard.admin.delivery.providerRouting.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: ['auth', 'admin'],
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
	localized(transportLabel(transportOptions.value, providerType));
const strategyLabelFor = (strategy: string): string =>
	localized(strategyLabel(strategy as Strategy));
const providerAvailable = (providerType: string): boolean =>
	isTransportAvailable(transportOptions.value, providerType);

// ── Mutations ───────────────────────────────────────────────────────
const { run: setRoute } = useBackendOperation(api.providerRoutes.setRoute, {
	label: () => t('dashboard.admin.delivery.providerRouting.operations.save'),
});
const { run: removeRoute } = useBackendOperation(api.providerRoutes.removeRoute, {
	label: () => t('dashboard.admin.delivery.providerRouting.operations.reset'),
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
const editStrategyDescription = computed(() => {
	const entry = STRATEGIES.find((s) => s.value === editStrategy.value);
	return entry ? localized(entry.description) : '';
});

// Non-blocking warning when the typed IP pool isn't one the MTA understands.
const ipPoolWarning = computed(() => {
	const warning = unknownIpPoolWarning(editIpPool.value, ipPools.value);
	return warning === null || warning === undefined ? null : localized(warning);
});

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

// A controller-owned strategy is displayed, never picked — and it is written
// back unchanged, so an unrelated edit cannot downgrade the route.
const isEditStrategyManaged = computed(() => isControllerOwnedStrategy(editStrategy.value));

const enabledProviderCount = computed(() => editProviders.value.filter((p) => p.isEnabled).length);

async function handleSave() {
	if (!hasActiveOrganization.value) return;

	const enabled = editProviders.value.filter((p) => p.isEnabled);
	if (enabled.length === 0) {
		showNotification(t('dashboard.admin.delivery.providerRouting.errors.noProvider'), 'error');
		return;
	}
	// The backend's own rule and the backend's own sentence (D6), so the screen
	// refuses exactly what `setRoute` would refuse and says the same thing.
	if (editFallbackEnabled.value) {
		const issue = fallbackRelayIssue(editProviders.value, editFallbackRelay.value);
		if (issue !== null) {
			showNotification(localized(issue), 'error');
			return;
		}
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

	if (!result.ok) return;

	showNotification(t('dashboard.admin.delivery.providerRouting.toasts.saved'));
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
	if (!result.ok) return;
	showNotification(t('dashboard.admin.delivery.providerRouting.toasts.reset'));
	resetMessageType.value = null;
}
</script>

<template>
	<div class="p-6 lg:p-8">
		<!-- Header -->
		<div class="mb-6">
			<NuxtLink
				to="/dashboard/admin/delivery"
				class="inline-flex items-center gap-2 text-sm text-text-secondary hover:text-text-primary mb-4"
			>
				<Icon name="lucide:arrow-left" class="w-4 h-4" />
				{{ t('dashboard.admin.delivery.backToSetup') }}
			</NuxtLink>
			<div class="flex items-center gap-3">
				<UiIconBox icon="lucide:route" size="lg" variant="brand" rounded="xl" />
				<div>
					<h1 class="text-2xl font-medium tracking-[-0.02em] text-text-primary">
						{{ t('dashboard.admin.delivery.providerRouting.title') }}
					</h1>
					<p class="mt-1 text-text-secondary">
						{{ t('dashboard.admin.delivery.providerRouting.lede') }}
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
			<p class="text-text-secondary font-medium">
				{{ t('dashboard.admin.delivery.providerRouting.noWorkspace.title') }}
			</p>
			<p class="text-sm text-text-tertiary mt-1 max-w-sm">
				{{ t('dashboard.admin.delivery.providerRouting.noWorkspace.description') }}
			</p>
		</div>

		<!-- Content -->
		<div v-else class="space-y-6">
			<!-- Info Card -->
			<div class="card p-6 bg-brand/5 border-brand/20">
				<div class="flex gap-4">
					<UiIconBox icon="lucide:info" size="sm" variant="brand" rounded="lg" />
					<div>
						<h3 class="font-medium text-text-primary mb-1">
							{{ t('dashboard.admin.delivery.providerRouting.howItWorks.title') }}
						</h3>
						<I18nT
							keypath="dashboard.admin.delivery.providerRouting.howItWorks.body"
							tag="p"
							class="text-sm text-text-secondary"
							scope="global"
						>
							<template #envVar>
								<code class="px-1 py-0.5 rounded bg-bg-surface text-text-primary text-xs"
									>EMAIL_PROVIDER</code
								>
							</template>
						</I18nT>
					</div>
				</div>
			</div>

			<DeliveryReferenceRelayNotice />

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
								<h3 class="text-lg font-medium text-text-primary">{{ localized(type.label) }}</h3>
								<p class="text-sm text-text-secondary mt-0.5">
									{{ localized(type.description) }}
								</p>

								<!-- Configured route summary -->
								<DeliveryProviderRouteSummary
									v-if="routeByType.get(type.value)"
									:route="routeByType.get(type.value)!"
									:strategy-label="strategyLabelFor"
									:provider-label="providerLabel"
								/>

								<!-- Default fallback summary -->
								<p v-else class="mt-3 text-xs text-text-tertiary inline-flex items-center gap-1.5">
									<Icon name="lucide:server" class="w-3.5 h-3.5" />
									{{ t('dashboard.admin.delivery.providerRouting.usingDefault') }}
								</p>
							</div>
						</div>

						<div class="flex items-center gap-2 shrink-0">
							<UiButton
								variant="ghost"
								v-if="routeByType.get(type.value)"
								class="p-2 text-error hover:bg-error/10"
								:title="t('dashboard.admin.delivery.providerRouting.resetToDefault')"
								@click="resetMessageType = type.value"
							>
								<Icon name="lucide:rotate-ccw" class="w-4 h-4" />
							</UiButton>
							<UiButton variant="secondary" class="gap-2" @click="startEdit(type.value)">
								<Icon name="lucide:settings-2" class="w-4 h-4" />
								{{
									routeByType.get(type.value)
										? t('common.edit')
										: t('dashboard.admin.delivery.providerRouting.configure')
								}}
							</UiButton>
						</div>
					</div>
				</div>
			</div>
		</div>

		<!-- Edit Modal -->
		<UiModal
			v-model:open="editOpen"
			:title="
				t('dashboard.admin.delivery.providerRouting.editModal.title', {
					messageType: editMessageTypeMeta ? localized(editMessageTypeMeta.label) : '',
				})
			"
		>
			<div class="space-y-5">
				<!-- Strategy -->
				<div>
					<template v-if="isEditStrategyManaged">
						<span class="label">{{
							t('dashboard.admin.delivery.providerRouting.editModal.strategy')
						}}</span>
						<p class="input flex items-center gap-2">
							<span>{{ strategyLabelFor(editStrategy) }}</span>
							<span class="rounded-full border px-2 py-0.5 text-xs font-medium">{{
								t('dashboard.admin.delivery.providerRouting.editModal.managed')
							}}</span>
						</p>
						<p class="mt-1 text-xs text-text-tertiary">
							{{ t('dashboard.admin.delivery.providerRouting.editModal.managedNote') }}
						</p>
					</template>
					<template v-else>
						<label for="route-strategy" class="label">{{
							t('dashboard.admin.delivery.providerRouting.editModal.strategy')
						}}</label>
						<select id="route-strategy" v-model="editStrategy" class="input">
							<option v-for="strategy in STRATEGIES" :key="strategy.value" :value="strategy.value">
								{{ localized(strategy.label) }}
							</option>
						</select>
						<p class="mt-1 text-xs text-text-tertiary">
							{{ editStrategyDescription }}
						</p>
					</template>
				</div>

				<!-- Providers -->
				<DeliveryProviderRouteProviderList
					v-model="editProviders"
					:strategy="editStrategy"
					:provider-label="providerLabel"
					:provider-available="providerAvailable"
				/>

				<!-- IP pool -->
				<div>
					<label for="route-ip-pool" class="label">{{
						t('dashboard.admin.delivery.providerRouting.editModal.ipPool')
					}}</label>
					<input
						id="route-ip-pool"
						v-model="editIpPool"
						type="text"
						:placeholder="t('dashboard.admin.delivery.providerRouting.editModal.ipPoolPlaceholder')"
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
						{{ t('dashboard.admin.delivery.providerRouting.editModal.ipPoolHint') }}
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
					{{ t('common.cancel') }}
				</UiButton>
				<UiButton :loading="isSaving" :disabled="enabledProviderCount === 0" @click="handleSave">
					{{
						isSaving
							? t('dashboard.admin.delivery.providerRouting.editModal.saving')
							: t('dashboard.admin.delivery.providerRouting.editModal.save')
					}}
				</UiButton>
			</template>
		</UiModal>

		<!-- Reset Confirmation -->
		<UiConfirmationDialog
			:open="!!resetMessageType"
			variant="danger"
			:title="t('dashboard.admin.delivery.providerRouting.resetModal.title')"
			:description="t('dashboard.admin.delivery.providerRouting.resetModal.description')"
			:confirm-text="t('dashboard.admin.delivery.providerRouting.resetModal.confirm')"
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
