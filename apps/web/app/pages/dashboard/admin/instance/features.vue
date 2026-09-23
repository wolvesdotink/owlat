<script setup lang="ts">
import { api } from '@owlat/api';
import { getBundledPluginFeatureFlagDefinitions } from '@owlat/plugin-host';
import {
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
import {
	enableTimeMissingEnvVars,
	flagsNeedingConfig,
	missingPluginEnvironmentVariables,
} from '~/utils/featureConfig';
import { hasInboundFeature, INBOUND_FEATURE_FLAGS } from '~/utils/inboundDns';
import { bundledPluginComposition } from '~/plugins/plugin-composition.generated';
import FeaturePackList from '~/components/settings/FeaturePackList.vue';
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
const { flagLabel, flagKeyLabel, packLabel } = useFeatureCopy();

/** Name flags by their label, not their key, in toasts. */
const flagNames = (keys: readonly string[]) =>
	keys.map((k) => flagKeyLabel(k, featureFlagRegistry[k])).join(', ');

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
const missingEnv = ref<{
	flag: FeatureFlagKey;
	vars: string[];
	needsDeliveryProvider?: boolean;
} | null>(null);
const pendingPluginApproval = ref<{
	flag: FeatureFlagKey;
	capabilities: readonly string[];
} | null>(null);

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
		// Name only what the deployment is actually missing — `mail.external`
		// declares its worker variables, and an instance that already has them set
		// should not be told to go set them. The status query is the only evidence
		// available here (the browser cannot read `.env`); when it has not answered,
		// `enableTimeMissingEnvVars` falls back to the full declared list.
		const vars = enableTimeMissingEnvVars(
			def,
			configStatusError.value ? null : flagsConfigStatus.value
		);
		if (vars.length > 0) missingEnv.value = { flag, vars };
	}

	// Sending flags declare no requiredEnvVars (the provider is env+capability,
	// not a flag dependency), so the check above is blind to them. Drive the same
	// best-effort hint from the live delivery-configured state.
	const isSendingFlag = (SENDING_FLAGS_REQUIRING_DELIVERY as readonly string[]).includes(flag);
	if (value && isSendingFlag && deliveryConfigured.value === false) {
		missingEnv.value = { flag, vars: [], needsDeliveryProvider: true };
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

/** Why a plugin flag can't be turned on yet; dependency reasons come from the list. */
function pluginBlockedReason(def: FeatureFlagDefinition): string | undefined {
	if (!isPluginEnableBlocked(def.key)) return undefined;
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
				flags: flagNames(res.result.cascaded),
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

async function togglePack(packKey: FeaturePackKey) {
	const current = isPackEnabled(stored.value, packKey);
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
				flags: flagNames(res.result.cascaded),
			})
		);
	}
}
</script>

<template>
	<div>
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
			<FeaturePackList
				:registry="featureFlagRegistry"
				:stored="stored"
				:resolved="resolved"
				:flags-busy="isSavingFlag"
				:packs-busy="isSavingPack"
				:flag-blocked-reason="pluginBlockedReason"
				:needs-config="needsConfig"
				:missing-config="flagsConfigStatus"
				@toggle-pack="togglePack"
				@toggle-flag="onToggle"
			>
				<template #group-notice="{ group }">
					<PluginConfigStatusNotice
						v-if="group.categories.includes('plugins')"
						:is-loading="isConfigStatusLoading"
						:error-message="configStatusError ? configStatusErrorMessage : undefined"
						@retry="retryConfigStatus"
					/>

					<!-- Inbound DNS hint: receiving needs MX + inbound-port setup, the
					     inbound mirror of pointing a sending flag at a delivery provider. -->
					<div
						v-if="group.key === 'emailClient' && hasInboundFeature(resolved)"
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
				</template>
			</FeaturePackList>
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
