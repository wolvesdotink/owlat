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
	type FeatureFlagDefinition,
	type FeatureFlagKey,
	type FeatureFlagState,
	type FeaturePackKey,
} from '@owlat/shared/featureFlags';
import { flagsNeedingConfig, missingPluginEnvironmentVariables } from '~/utils/featureConfig';
import { hasInboundFeature, INBOUND_FEATURE_FLAGS } from '~/utils/inboundDns';
import { bundledPluginComposition } from '~/plugins/plugin-composition.generated';
import FeatureFlagMetadata from '~/components/settings/FeatureFlagMetadata.vue';
import FeatureToggleSwitch from '~/components/settings/FeatureToggleSwitch.vue';
import PluginConfigStatusNotice from '~/components/settings/PluginConfigStatusNotice.vue';
import ProfileSyncBanner from '~/components/settings/ProfileSyncBanner.vue';
import FeatureFlagToggleDialogs from '~/components/settings/FeatureFlagToggleDialogs.vue';
import { useProfileSync } from '~/composables/useProfileSync';
import { useFeatureCopy } from '~/composables/useFeatureCopy';

const pluginFeatureFlagDefinitions =
	getBundledPluginFeatureFlagDefinitions(bundledPluginComposition);
const featureFlagRegistry = createFeatureFlagRegistry(pluginFeatureFlagDefinitions);

const { t } = useI18n();
// The shared registry keeps its English (the setup CLI prints it, and plugin
// definitions are minted at runtime); these resolve it through the catalog.
const { flagLabel, flagKeyLabel, flagDescription, packLabel, packDescription } = useFeatureCopy();

useHead({ title: () => t('dashboard.admin.instance.features.pageTitle') });
definePageMeta({ layout: 'admin', middleware: ['auth', 'admin'] });

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

// Toggles only persist flags in Convex; when they change the derived
// docker-profile set, the out-of-sync banner offers the explicit Apply (D4).
const { trackFlagChange } = useProfileSync();

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

/**
 * Why a flag's toggle is dependency-blocked, or `undefined` when it isn't.
 * All `requires` parents must be ON; each `requiresAny` group needs at least
 * one ON member. Cascade-on never auto-enables a group member (there is no
 * principled choice of which), so the toggle stays disabled with this hint.
 */
function dependencyHint(def: FeatureFlagDefinition): string | undefined {
	if (def.requires?.some((dep) => !resolved.value[dep])) {
		return t('dashboard.admin.instance.features.enableRequiredFirst', {
			flags: def.requires.join(', '),
		});
	}
	const unsatisfied = (def.requiresAny ?? []).filter(
		(group) => !group.some((member) => resolved.value[member])
	);
	if (unsatisfied.length === 0) return undefined;
	return unsatisfied
		.map((group) =>
			t('dashboard.admin.instance.features.needsOneOf', {
				flags: group.map((k) => flagKeyLabel(k, featureFlagRegistry[k])).join(', '),
			})
		)
		.join(' · ');
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
	const before = stored.value;
	const res = await setFeatureFlag({
		flag,
		value,
		...(approvedCapabilities ? { approvedCapabilities: [...approvedCapabilities] } : {}),
	});
	pendingCascade.value = null;
	pendingPluginApproval.value = null;
	if (!res.ok) return; // failure already toasted by the operation module
	trackFlagChange(before, res.result.flags, featureFlagRegistry);
	const definition = featureFlagRegistry[flag];
	const label = definition ? flagLabel(definition) : flag;
	showToast(
		value
			? t('dashboard.admin.instance.features.toasts.flagEnabled', { label })
			: t('dashboard.admin.instance.features.toasts.flagDisabled', { label })
	);
	if (res.result.cascaded.length > 0) {
		showToast(
			t('dashboard.admin.instance.features.toasts.alsoDisabled', {
				flags: res.result.cascaded.join(', '),
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
	const before = stored.value;
	const res = await setFeaturePack({ pack: packKey, value: nextValue });
	if (!res.ok) return; // failure already toasted
	trackFlagChange(before, res.result.flags, featureFlagRegistry);
	const label = packLabel(packKey);
	showToast(
		nextValue
			? t('dashboard.admin.instance.features.toasts.packEnabled', { label })
			: t('dashboard.admin.instance.features.toasts.packDisabled', { label })
	);
	if (res.result.cascaded.length > 0) {
		showToast(
			t('dashboard.admin.instance.features.toasts.alsoAffected', {
				flags: res.result.cascaded.join(', '),
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

		<!-- Persistent apply banner: toggles that change the docker-profile set
		     leave services out of sync until an explicit Apply (D4). -->
		<ProfileSyncBanner :flags="resolved" class="mb-6" />

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
									<p class="font-medium text-text-primary">{{ packLabel(packKey) }}</p>
									<span
										v-if="packState[packKey] === 'partial'"
										class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-warning/10 text-warning"
									>
										{{ t('dashboard.admin.instance.features.packs.partial') }}
									</span>
								</div>
								<p class="text-sm text-text-secondary mt-0.5">
									{{ packDescription(packKey) }}
								</p>
								<p class="text-xs text-text-tertiary mt-1 font-mono">
									{{
										t('dashboard.admin.instance.features.packs.flags', {
											flags: FEATURE_PACKS[packKey].flags.join(', '),
										})
									}}
								</p>
							</div>
							<FeatureToggleSwitch
								:state="packState[packKey]"
								:label="packLabel(packKey)"
								:disabled="isSavingPack"
								@toggle="togglePack(packKey)"
							/>
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
									<p class="font-medium text-text-primary">{{ flagLabel(def) }}</p>
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
								<p class="text-sm text-text-secondary mt-0.5">{{ flagDescription(def) }}</p>
								<FeatureFlagMetadata :definition="def" />
							</div>
							<FeatureToggleSwitch
								:state="resolved[def.key] ? 'on' : 'off'"
								:label="flagLabel(def)"
								:data-testid="`feature-switch-${def.key}`"
								:disabled="
									isSavingFlag ||
									isPluginEnableBlocked(def.key) ||
									dependencyHint(def) !== undefined
								"
								:title="dependencyHint(def) ?? pluginStatusTitle(def.key)"
								@toggle="onToggle(def.key, !resolved[def.key])"
							/>
						</div>
					</div>
				</UiCard>
			</div>
		</UiQueryBoundary>

		<FeatureFlagToggleDialogs
			:pending-cascade="pendingCascade"
			:pending-plugin-approval="pendingPluginApproval"
			:missing-env="missingEnv"
			:registry="featureFlagRegistry"
			:is-saving="isSavingFlag"
			@close-cascade="pendingCascade = null"
			@close-approval="pendingPluginApproval = null"
			@close-missing-env="missingEnv = null"
			@confirm-cascade="confirmCascade"
			@confirm-approval="confirmPluginApproval"
		/>
	</div>
</template>
