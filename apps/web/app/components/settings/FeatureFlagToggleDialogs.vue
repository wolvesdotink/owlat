<script setup lang="ts">
import type { FeatureFlagKey, FeatureFlagRegistry } from '@owlat/shared/featureFlags';
import { useFeatureCopy } from '~/composables/useFeatureCopy';

/**
 * The three confirmation surfaces a feature-flag toggle can raise on the
 * Instance → Features page: the cascade warning (disabling a flag others depend
 * on), the bundled-plugin capability approval, and the missing-environment hint.
 * They share one registry lookup for labels and one "the page is saving" state,
 * so they travel together; the page owns the pending state and commits the
 * toggle, this component only asks. The label lookup goes through
 * `useFeatureCopy()`, because the shared registry's own copy is English — the
 * catalog holds the words for every core flag, and a plugin flag falls back to
 * the definition the plugin host minted for it.
 */
defineProps<{
	pendingCascade: { flag: FeatureFlagKey; value: boolean; cascaded: FeatureFlagKey[] } | null;
	pendingPluginApproval: { flag: FeatureFlagKey; capabilities: readonly string[] } | null;
	/**
	 * What enabling the flag still needs: environment variables by name, or —
	 * for a sending flag — a delivery provider, which is set up on its own page
	 * rather than as one variable.
	 */
	missingEnv: { flag: FeatureFlagKey; vars: string[]; needsDeliveryProvider?: boolean } | null;
	registry: FeatureFlagRegistry;
	isSaving: boolean;
}>();

defineEmits<{
	closeCascade: [];
	closeApproval: [];
	closeMissingEnv: [];
	confirmCascade: [];
	confirmApproval: [];
}>();

const { t } = useI18n();
const { flagKeyLabel } = useFeatureCopy();
</script>

<template>
	<!-- Cascade confirmation -->
	<UiConfirmationDialog
		:open="!!pendingCascade"
		variant="warning"
		:title="
			pendingCascade
				? t('dashboard.admin.instance.features.cascade.title', {
						label: flagKeyLabel(pendingCascade.flag, registry[pendingCascade.flag]),
					})
				: t('dashboard.admin.instance.features.cascade.titleFallback')
		"
		:description="t('dashboard.admin.instance.features.cascade.description')"
		:confirm-text="t('dashboard.admin.instance.features.cascade.confirm')"
		:cancel-text="t('common.cancel')"
		:is-loading="isSaving"
		@update:open="(v: boolean) => !v && $emit('closeCascade')"
		@confirm="$emit('confirmCascade')"
	>
		<ul v-if="pendingCascade" class="mt-4 text-left space-y-1.5">
			<li
				v-for="key in pendingCascade.cascaded"
				:key="key"
				class="text-sm text-text-secondary flex items-center gap-2"
			>
				<Icon name="lucide:corner-down-right" class="w-3.5 h-3.5 text-text-tertiary shrink-0" />
				<code class="text-xs bg-bg-surface px-1.5 py-0.5 rounded">{{ key }}</code>
				<span class="truncate">{{ flagKeyLabel(key, registry[key]) }}</span>
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
						label: flagKeyLabel(pendingPluginApproval.flag, registry[pendingPluginApproval.flag]),
					})
				: t('dashboard.admin.instance.features.approval.titleFallback')
		"
		:description="t('dashboard.admin.instance.features.approval.description')"
		:confirm-text="t('dashboard.admin.instance.features.approval.confirm')"
		:cancel-text="t('common.cancel')"
		:is-loading="isSaving"
		@update:open="(value: boolean) => !value && $emit('closeApproval')"
		@confirm="$emit('confirmApproval')"
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
						label: flagKeyLabel(missingEnv.flag, registry[missingEnv.flag]),
					})
				: t('dashboard.admin.instance.features.missingEnv.titleFallback')
		"
		@update:open="(v: boolean) => !v && $emit('closeMissingEnv')"
	>
		<!-- A sending flag needs a provider, not one variable: send the operator
		     to the page that sets one up. -->
		<div v-if="missingEnv?.needsDeliveryProvider" class="space-y-3">
			<p class="text-text-secondary">
				{{ t('dashboard.admin.instance.features.missingEnv.deliveryBody') }}
			</p>
			<UiButton
				variant="secondary"
				to="/dashboard/admin/delivery/transport"
				@click="$emit('closeMissingEnv')"
			>
				{{ t('dashboard.admin.instance.features.missingEnv.openDelivery') }}
			</UiButton>
		</div>
		<!-- The same copyable .env lines and `owlat` commands every delivery page
		     hands over. This page cannot see the server's .env, so it does not wait
		     for a connection. -->
		<DeliveryEnvSetupSteps
			v-else-if="missingEnv"
			:variables="missingEnv.vars"
			:connected="false"
			:await-connection="false"
		/>

		<template #footer>
			<UiButton @click="$emit('closeMissingEnv')">{{
				t('dashboard.admin.instance.features.missingEnv.gotIt')
			}}</UiButton>
		</template>
	</UiModal>
</template>
