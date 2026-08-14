<script setup lang="ts">
import { api } from '@owlat/api';
import { getBundledPluginFeatureFlagDefinitions } from '@owlat/plugin-host';
import {
	FEATURE_PACKS,
	ALL_FEATURE_PACK_KEYS,
	getFlagsByCategory,
	isPackEnabled,
	resolveFlags,
	applyToggle,
	createFeatureFlagRegistry,
	isPluginFeatureFlagDefinition,
	SENDING_FLAGS_REQUIRING_DELIVERY,
	type FeatureFlagKey,
	type FeatureFlagState,
	type FeaturePackKey,
} from '@owlat/shared/featureFlags';
import { flagsNeedingConfig, missingPluginEnvironmentVariables } from '~/utils/featureConfig';
import { hasInboundFeature, INBOUND_FEATURE_FLAGS } from '~/utils/inboundDns';
import { bundledPluginComposition } from '~/plugins/plugin-composition.generated';
import FeatureFlagMetadata from '~/components/settings/FeatureFlagMetadata.vue';
import PluginConfigStatusNotice from '~/components/settings/PluginConfigStatusNotice.vue';

const pluginFeatureFlagDefinitions =
	getBundledPluginFeatureFlagDefinitions(bundledPluginComposition);
const featureFlagRegistry = createFeatureFlagRegistry(pluginFeatureFlagDefinitions);

const { t } = useI18n();

useHead({ title: () => t('dashboard.admin.instance.features.pageTitle') });
definePageMeta({ layout: 'dashboard', middleware: ['auth', 'admin'] });

const {
	data: liveFlags,
	isLoading,
	error: flagsError,
} = useConvexQuery(api.workspaces.featureFlags.getFeatureFlags, {});
const { data: deliveryConfigured } = useConvexQuery(
	api.workspaces.featureFlags.deliveryConfigured,
	{}
);
const {
	data: flagsConfigStatus,
	isLoading: isConfigStatusLoading,
	error: configStatusError,
	refetch: retryConfigStatus,
} = useConvexQuery(api.workspaces.featureFlags.getFlagsConfigStatus, {});
const { showToast } = useToast();

// Writes go through the Operation module (ADR-0036): categorized failures are
// toasted + telemetry'd automatically and `run` resolves to `undefined`; we only
// add the success / cascade-info toasts here.
const { run: setFeatureFlag, isLoading: isSavingFlag } = useBackendOperation(
	api.workspaces.featureFlags.setFeatureFlag,
	{ label: () => t('dashboard.admin.instance.features.toggleFlagOperation') }
);
const { run: setFeaturePack, isLoading: isSavingPack } = useBackendOperation(
	api.workspaces.featureFlags.setFeaturePack,
	{ label: () => t('dashboard.admin.instance.features.togglePackOperation') }
);

const byCategory = computed(() => getFlagsByCategory({ registry: featureFlagRegistry }));

const stored = computed<FeatureFlagState>(() => (liveFlags.value ?? {}) as FeatureFlagState);
const resolved = computed(() => resolveFlags(stored.value, { registry: featureFlagRegistry }));

// Flags that are enabled yet still missing configuration → badged "needs config".
const needsConfig = computed(() => flagsNeedingConfig(resolved.value, flagsConfigStatus.value));
const configStatusErrorMessage = computed(() =>
	configStatusError.value instanceof Error
		? configStatusError.value.message
		: t('dashboard.admin.instance.features.configUnverified')
);

const pendingCascade = ref<{
	flag: FeatureFlagKey;
	value: boolean;
	cascaded: FeatureFlagKey[];
} | null>(null);
const missingEnv = ref<{ flag: FeatureFlagKey; vars: string[] } | null>(null);
const pendingPluginApproval = ref<{
	flag: FeatureFlagKey;
	capabilities: readonly string[];
} | null>(null);

const CATEGORY_KEYS = [
	'sending',
	'receiving',
	'ai',
	'integrations',
	'security',
	'deliverability',
	'plugins',
] as const;

function categoryLabel(cat: string): string {
	return (CATEGORY_KEYS as readonly string[]).includes(cat)
		? t(`dashboard.admin.instance.features.categories.${cat}`)
		: cat;
}

async function onToggle(flag: FeatureFlagKey, value: boolean) {
	// Preview cascade before committing.
	const preview = applyToggle(stored.value, flag, value, featureFlagRegistry);
	const cascaded = preview.cascaded;

	// If enabling a feature that requires env vars not in the running env,
	// surface a modal asking for them. (We can't read .env from the browser,
	// so this is a best-effort note, not a hard gate.)
	const def = featureFlagRegistry[flag];
	if (!def) return;
	if (value && isPluginFeatureFlagDefinition(def)) {
		if (configStatusError.value) {
			showToast(t('dashboard.admin.instance.features.toasts.configUnverified'));
			return;
		}
		if (flagsConfigStatus.value == null) {
			showToast(t('dashboard.admin.instance.features.toasts.configLoading'));
			return;
		}
		const missingPluginEnv = missingPluginEnvironmentVariables(def, flagsConfigStatus.value);
		if (missingPluginEnv.length > 0) {
			missingEnv.value = { flag, vars: missingPluginEnv };
			return;
		}
		const capabilities = def.requiredCapabilities;
		if (capabilities.length > 0) {
			pendingPluginApproval.value = { flag, capabilities };
			return;
		}
		await commitToggle(flag, true, []);
		return;
	}
	if (value && (def.requiredEnvVars?.length ?? 0) > 0) {
		missingEnv.value = { flag, vars: [...(def.requiredEnvVars ?? [])] };
	}

	// Sending flags declare no requiredEnvVars (the provider is env+capability,
	// not a flag dependency), so the check above is blind to them. Drive the same
	// best-effort hint from the live delivery-configured state.
	const isSendingFlag = (SENDING_FLAGS_REQUIRING_DELIVERY as readonly string[]).includes(flag);
	if (value && isSendingFlag && deliveryConfigured.value === false) {
		missingEnv.value = {
			flag,
			vars: [t('dashboard.admin.instance.features.deliveryProviderRequirement')],
		};
	}

	// Disabling a feature that others depend on needs explicit confirmation.
	if (cascaded.length > 0 && !value) {
		pendingCascade.value = { flag, value, cascaded };
		return;
	}

	await commitToggle(flag, value);
}

function isPluginEnableBlocked(flag: FeatureFlagKey): boolean {
	const definition = featureFlagRegistry[flag];
	return (
		definition !== undefined &&
		isPluginFeatureFlagDefinition(definition) &&
		resolved.value[flag] !== true &&
		(isConfigStatusLoading.value ||
			configStatusError.value !== null ||
			flagsConfigStatus.value == null)
	);
}

function pluginStatusTitle(flag: FeatureFlagKey): string | undefined {
	if (!isPluginEnableBlocked(flag)) return undefined;
	return configStatusError.value
		? t('dashboard.admin.instance.features.pluginStatus.retryFirst')
		: t('dashboard.admin.instance.features.pluginStatus.loading');
}

async function commitToggle(
	flag: FeatureFlagKey,
	value: boolean,
	approvedCapabilities?: readonly string[]
) {
	const res = await setFeatureFlag({
		flag,
		value,
		...(approvedCapabilities ? { approvedCapabilities: [...approvedCapabilities] } : {}),
	});
	pendingCascade.value = null;
	pendingPluginApproval.value = null;
	if (res === undefined) return; // failure already toasted by the operation module
	const label = featureFlagRegistry[flag]?.label ?? flag;
	showToast(
		value
			? t('dashboard.admin.instance.features.toasts.flagEnabled', { label })
			: t('dashboard.admin.instance.features.toasts.flagDisabled', { label })
	);
	if (res.cascaded.length > 0) {
		showToast(
			t('dashboard.admin.instance.features.toasts.alsoDisabled', {
				flags: res.cascaded.join(', '),
			})
		);
	}
	// Enabling an inbound surface needs MX/inbound-port DNS to actually receive
	// mail — point the operator at the Domains → Receiving guidance, the inbound
	// mirror of how a sending flag points at a delivery provider above.
	if (value && (INBOUND_FEATURE_FLAGS as readonly string[]).includes(flag)) {
		showToast(t('dashboard.admin.instance.features.toasts.inboundDns'));
	}
}

function confirmPluginApproval() {
	if (!pendingPluginApproval.value) return;
	void commitToggle(
		pendingPluginApproval.value.flag,
		true,
		pendingPluginApproval.value.capabilities
	);
}

function confirmCascade() {
	if (!pendingCascade.value) return;
	void commitToggle(pendingCascade.value.flag, pendingCascade.value.value);
}

// ─── Feature packs ───────────────────────────────────────────────────────────

const packState = computed(() => {
	const state: Record<FeaturePackKey, 'on' | 'off' | 'partial'> = {} as Record<
		FeaturePackKey,
		'on' | 'off' | 'partial'
	>;
	for (const key of ALL_FEATURE_PACK_KEYS) {
		state[key] = isPackEnabled(stored.value, key);
	}
	return state;
});

async function togglePack(packKey: FeaturePackKey) {
	const current = packState.value[packKey];
	const nextValue = current !== 'on'; // off/partial → on; on → off
	const res = await setFeaturePack({ pack: packKey, value: nextValue });
	if (res === undefined) return; // failure already toasted
	const label = FEATURE_PACKS[packKey].label;
	showToast(
		nextValue
			? t('dashboard.admin.instance.features.toasts.packEnabled', { label })
			: t('dashboard.admin.instance.features.toasts.packDisabled', { label })
	);
	if (res.cascaded.length > 0) {
		showToast(
			t('dashboard.admin.instance.features.toasts.alsoAffected', {
				flags: res.cascaded.join(', '),
			})
		);
	}
}
</script>

<template>
	<div class="p-6 lg:p-8 max-w-4xl mx-auto">
		<!-- Header -->
		<div class="mb-8">
			<h1 class="text-2xl font-medium tracking-[-0.02em] text-text-primary">
				{{ t('dashboard.admin.instance.features.title') }}
			</h1>
			<p class="mt-1 text-text-secondary max-w-2xl">
				{{ t('dashboard.admin.instance.features.subtitle') }}
			</p>
		</div>

		<UiQueryBoundary :loading="isLoading && !liveFlags" :error="flagsError">
			<div class="space-y-8">
				<!-- Feature packs -->
				<UiCard padding="none" overflow="hidden">
					<template #header>
						<div class="flex items-center gap-3">
							<UiIconBox icon="lucide:package" size="sm" variant="surface" rounded="lg" />
							<div>
								<h2 class="text-lg font-semibold text-text-primary">
									{{ t('dashboard.admin.instance.features.packs.title') }}
								</h2>
								<p class="text-sm text-text-secondary">
									{{ t('dashboard.admin.instance.features.packs.description') }}
								</p>
							</div>
						</div>
					</template>

					<div class="divide-y divide-border-subtle">
						<div
							v-for="packKey in ALL_FEATURE_PACK_KEYS"
							:key="packKey"
							class="px-6 py-4 flex items-center justify-between gap-4"
						>
							<div class="min-w-0">
								<div class="flex items-center gap-2">
									<p class="font-medium text-text-primary">{{ FEATURE_PACKS[packKey].label }}</p>
									<span
										v-if="packState[packKey] === 'partial'"
										class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-warning/10 text-warning"
									>
										{{ t('dashboard.admin.instance.features.packs.partial') }}
									</span>
								</div>
								<p class="text-sm text-text-secondary mt-0.5">
									{{ FEATURE_PACKS[packKey].description }}
								</p>
								<p class="text-xs text-text-tertiary mt-1 font-mono">
									{{
										t('dashboard.admin.instance.features.packs.flags', {
											flags: FEATURE_PACKS[packKey].flags.join(', '),
										})
									}}
								</p>
							</div>
							<button
								type="button"
								role="switch"
								:aria-checked="packState[packKey] === 'on'"
								:aria-label="
									t('dashboard.admin.instance.features.toggleAria', {
										label: FEATURE_PACKS[packKey].label,
									})
								"
								class="relative inline-flex shrink-0 h-6 w-11 items-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50"
								:class="
									packState[packKey] === 'on'
										? 'bg-brand border-brand'
										: packState[packKey] === 'partial'
											? 'bg-warning/60 border-warning/60'
											: 'bg-bg-surface border-border-subtle'
								"
								:disabled="isSavingPack"
								@click="togglePack(packKey)"
							>
								<!-- palette-ok: fixed white thumb on a brand/warning/surface track (the puck packages/ui Switch.vue draws; this tri-state toggle stays bespoke). -->
								<span
									class="inline-block h-5 w-5 transform rounded-full bg-white transition-transform"
									:class="
										packState[packKey] === 'on'
											? 'translate-x-[22px]'
											: packState[packKey] === 'partial'
												? 'translate-x-[11px]'
												: 'translate-x-0.5'
									"
								/>
							</button>
						</div>
					</div>
				</UiCard>

				<!-- Individual flags by category -->
				<UiCard v-for="(defs, cat) in byCategory" :key="cat" padding="none" overflow="hidden">
					<template #header>
						<h2 class="text-sm font-semibold text-text-tertiary uppercase tracking-wide">
							{{ categoryLabel(cat) }}
						</h2>
					</template>

					<PluginConfigStatusNotice
						v-if="cat === 'plugins'"
						:is-loading="isConfigStatusLoading"
						:error-message="configStatusError ? configStatusErrorMessage : undefined"
						@retry="retryConfigStatus"
					/>

					<!-- Inbound DNS hint: receiving needs MX + inbound-port setup, the
					     inbound mirror of pointing a sending flag at a delivery provider. -->
					<div
						v-if="cat === 'receiving' && hasInboundFeature(resolved)"
						class="px-6 py-3 bg-brand/5 border-b border-border-subtle flex items-start gap-3"
					>
						<Icon name="lucide:inbox" class="w-4 h-4 mt-0.5 text-brand shrink-0" />
						<I18nT
							keypath="dashboard.admin.instance.features.inboundDnsHint"
							tag="p"
							scope="global"
							class="text-sm text-text-secondary"
						>
							<template #link>
								<NuxtLink
									to="/dashboard/admin/delivery/domains"
									class="text-brand hover:underline font-medium"
									>{{ t('dashboard.admin.instance.features.inboundDnsLink') }}</NuxtLink
								>
							</template>
						</I18nT>
					</div>

					<div class="divide-y divide-border-subtle">
						<div
							v-for="def in defs"
							:key="def.key"
							class="px-6 py-4 flex items-center justify-between gap-4"
						>
							<div class="min-w-0">
								<div class="flex items-center gap-2 flex-wrap">
									<p class="font-medium text-text-primary">{{ def.label }}</p>
									<code class="text-xs text-text-tertiary bg-bg-surface px-1.5 py-0.5 rounded">{{
										def.key
									}}</code>
									<span
										v-if="needsConfig.has(def.key)"
										class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-warning/10 text-warning"
										:title="
											t('dashboard.admin.instance.features.needsConfigTitle', {
												missing: (flagsConfigStatus?.[def.key] ?? []).join(', '),
											})
										"
									>
										<Icon name="lucide:alert-triangle" class="w-3 h-3" />
										{{ t('dashboard.admin.instance.features.needsConfig') }}
									</span>
								</div>
								<p class="text-sm text-text-secondary mt-0.5">{{ def.description }}</p>
								<FeatureFlagMetadata :definition="def" />
							</div>
							<button
								type="button"
								role="switch"
								:aria-checked="resolved[def.key]"
								:aria-label="
									t('dashboard.admin.instance.features.toggleAria', { label: def.label })
								"
								:data-testid="`feature-switch-${def.key}`"
								class="relative inline-flex shrink-0 h-6 w-11 items-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-40 disabled:cursor-not-allowed"
								:class="
									resolved[def.key] ? 'bg-brand border-brand' : 'bg-bg-surface border-border-subtle'
								"
								:disabled="
									isSavingFlag ||
									isPluginEnableBlocked(def.key) ||
									def.requires?.some((dep) => !resolved[dep as FeatureFlagKey])
								"
								:title="
									def.requires?.some((dep) => !resolved[dep as FeatureFlagKey])
										? t('dashboard.admin.instance.features.enableRequiredFirst', {
												flags: def.requires?.join(', '),
											})
										: pluginStatusTitle(def.key)
								"
								@click="onToggle(def.key, !resolved[def.key])"
							>
								<!-- palette-ok: fixed white thumb on a brand/surface track, as above. -->
								<span
									class="inline-block h-5 w-5 transform rounded-full bg-white transition-transform"
									:class="resolved[def.key] ? 'translate-x-[22px]' : 'translate-x-0.5'"
								/>
							</button>
						</div>
					</div>
				</UiCard>
			</div>
		</UiQueryBoundary>

		<!-- Cascade confirmation -->
		<UiConfirmationDialog
			:open="!!pendingCascade"
			variant="warning"
			:title="
				pendingCascade
					? t('dashboard.admin.instance.features.cascade.title', {
							label: featureFlagRegistry[pendingCascade.flag]?.label ?? pendingCascade.flag,
						})
					: t('dashboard.admin.instance.features.cascade.titleFallback')
			"
			:description="t('dashboard.admin.instance.features.cascade.description')"
			:confirm-text="t('dashboard.admin.instance.features.cascade.confirm')"
			:cancel-text="t('common.cancel')"
			:is-loading="isSavingFlag"
			@update:open="(v: boolean) => !v && (pendingCascade = null)"
			@confirm="confirmCascade"
		>
			<ul v-if="pendingCascade" class="mt-4 text-left space-y-1.5">
				<li
					v-for="key in pendingCascade.cascaded"
					:key="key"
					class="text-sm text-text-secondary flex items-center gap-2"
				>
					<Icon name="lucide:corner-down-right" class="w-3.5 h-3.5 text-text-tertiary shrink-0" />
					<code class="text-xs bg-bg-surface px-1.5 py-0.5 rounded">{{ key }}</code>
					<span class="truncate">{{ featureFlagRegistry[key]?.label ?? key }}</span>
				</li>
			</ul>
		</UiConfirmationDialog>

		<!-- Bundled plugin capability approval -->
		<UiConfirmationDialog
			:open="!!pendingPluginApproval"
			variant="warning"
			:title="
				pendingPluginApproval
					? t('dashboard.admin.instance.features.approval.title', {
							label:
								featureFlagRegistry[pendingPluginApproval.flag]?.label ??
								pendingPluginApproval.flag,
						})
					: t('dashboard.admin.instance.features.approval.titleFallback')
			"
			:description="t('dashboard.admin.instance.features.approval.description')"
			:confirm-text="t('dashboard.admin.instance.features.approval.confirm')"
			:cancel-text="t('common.cancel')"
			:is-loading="isSavingFlag"
			@update:open="(value: boolean) => !value && (pendingPluginApproval = null)"
			@confirm="confirmPluginApproval"
		>
			<ul v-if="pendingPluginApproval" class="mt-4 text-left space-y-1.5">
				<li
					v-for="capability in pendingPluginApproval.capabilities"
					:key="capability"
					class="text-sm text-text-secondary flex items-center gap-2"
				>
					<Icon name="lucide:shield-check" class="w-3.5 h-3.5 text-warning shrink-0" />
					<code class="text-xs bg-bg-surface px-1.5 py-0.5 rounded">{{ capability }}</code>
				</li>
			</ul>
		</UiConfirmationDialog>

		<!-- Missing env hint -->
		<UiModal
			:open="!!missingEnv"
			:title="
				missingEnv
					? t('dashboard.admin.instance.features.missingEnv.title', {
							label: featureFlagRegistry[missingEnv.flag]?.label ?? missingEnv.flag,
						})
					: t('dashboard.admin.instance.features.missingEnv.titleFallback')
			"
			@update:open="(v: boolean) => !v && (missingEnv = null)"
		>
			<I18nT
				keypath="dashboard.admin.instance.features.missingEnv.body"
				tag="p"
				scope="global"
				class="text-text-secondary"
			>
				<template #path>
					<code class="text-sm bg-bg-surface px-1.5 py-0.5 rounded">/opt/owlat/.env</code>
				</template>
			</I18nT>
			<ul class="mt-3 space-y-1.5">
				<li v-for="v in missingEnv?.vars ?? []" :key="v">
					<code class="text-sm bg-bg-surface px-1.5 py-0.5 rounded">{{ v }}</code>
				</li>
			</ul>
			<I18nT
				keypath="dashboard.admin.instance.features.missingEnv.howTo"
				tag="p"
				scope="global"
				class="mt-3 text-sm text-text-tertiary"
			>
				<template #envCommand>
					<code class="bg-bg-surface px-1.5 py-0.5 rounded"
						>owlat env &lt;KEY&gt; &lt;VALUE&gt;</code
					>
				</template>
				<template #restartCommand>
					<code class="bg-bg-surface px-1.5 py-0.5 rounded">owlat restart</code>
				</template>
			</I18nT>

			<template #footer>
				<UiButton @click="missingEnv = null">{{
					t('dashboard.admin.instance.features.missingEnv.gotIt')
				}}</UiButton>
			</template>
		</UiModal>
	</div>
</template>
