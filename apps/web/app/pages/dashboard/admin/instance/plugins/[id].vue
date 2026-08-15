<script setup lang="ts">
import { api } from '@owlat/api';
import { bundledPluginComposition } from '~/plugins/plugin-composition.generated';
import PluginSettingsField from '~/components/settings/PluginSettingsField.vue';
import {
	hasPluginSettingsChanges,
	missingRequiredPluginSettings,
	pluginSettingsBaseline,
	pluginSettingsChanges,
	unsetRequiredPluginSecrets,
	type PluginSettingsForm,
	type PluginSettingsRedactedState,
} from '~/utils/pluginSettings';

definePageMeta({ layout: 'dashboard', middleware: ['auth', 'admin'] });

const { t } = useI18n();
const route = useRoute();
const pluginId = computed(() => String(route.params['id']));

const manifest = computed(
	() => bundledPluginComposition.find((plugin) => plugin.manifest.id === pluginId.value)?.manifest
);
const schema = computed(() => manifest.value?.settingsSchema ?? []);

useHead(() => ({ title: t('dashboard.admin.instance.plugins.detail.pageTitle', { pluginId: pluginId.value }) }));

// Plugin settings require `organization:manage` (the overview is an adminQuery),
// and the `admin` route middleware above is what enforces it here: it waits for
// the role and redirects a non-admin to /dashboard before this page renders. So
// there is no non-admin reader to skip the query for and no "Admins only" card to
// show one — every reader of this page is an owner or admin.
const {
	data: overview,
	isLoading,
	error,
} = useConvexQuery(api.plugins.settings.getPluginSettingsOverview, () => ({}));

const entry = computed(() =>
	overview.value?.plugins.find((plugin) => plugin.pluginId === pluginId.value)
);
const isOrphaned = computed(
	() =>
		overview.value?.orphaned.some((orphan) => orphan.pluginId === pluginId.value) === true &&
		!manifest.value
);

// The redacted server state the form is seeded and change-detected against.
// Seeded from the live overview when the entry first appears, then updated
// SYNCHRONOUSLY from each save/reset's returned redacted state (see below) so a
// later live-query re-emit cannot re-seed over edits typed in the meantime.
const serverState = ref<PluginSettingsRedactedState>({ values: {}, secretsSet: {} });
const baseline = computed(() => pluginSettingsBaseline(schema.value, serverState.value));

const { showToast } = useToast();
const { run: setPluginSettings, isLoading: isSaving } = useBackendOperation(
	api.plugins.settings.setPluginSettings,
	{ label: () => t('dashboard.admin.instance.plugins.detail.saveOperation') }
);
const { run: resetPluginSettings, isLoading: isResetting } = useBackendOperation(
	api.plugins.settings.resetPluginSettings,
	{ label: () => t('dashboard.admin.instance.plugins.detail.resetOperation') }
);

// Seed serverState + the editable form from a redacted state snapshot.
const form = ref<PluginSettingsForm>({});
let initializedFor: string | null = null;
function seedForm(next: PluginSettingsRedactedState) {
	serverState.value = { values: next.values, secretsSet: next.secretsSet };
	form.value = { ...pluginSettingsBaseline(schema.value, serverState.value) };
}

// Seed from the live overview the first time an entry appears (or when
// navigating to a different plugin id). A live re-emit for the SAME id does not
// re-seed — save()/reset() already updated serverState from the mutation's
// returned redacted state, so in-progress edits are never clobbered.
watch(
	entry,
	() => {
		if (!entry.value) return;
		if (initializedFor !== entry.value.pluginId) {
			seedForm({ values: entry.value.values, secretsSet: entry.value.secretsSet });
			initializedFor = entry.value.pluginId;
		}
	},
	{ immediate: true }
);

const isDirty = computed(() => hasPluginSettingsChanges(schema.value, form.value, baseline.value));
// Required secrets whose deployment variable is absent. Surfaced as a persistent
// warning, never as a save gate: they have no input on this form, so blocking the
// submit on one would strand every editable setting behind a deployment change.
const unsetSecrets = computed(() => unsetRequiredPluginSecrets(schema.value, serverState.value));
// Both destructive paths (in-form "Reset to defaults" and the orphaned-plugin
// "Clear residual settings") confirm before invoking reset(), so a single
// misclick can never wipe stored values, including saved secrets.
const showResetConfirm = ref(false);
const showOrphanClearConfirm = ref(false);

async function save() {
	const missing = missingRequiredPluginSettings(schema.value, form.value);
	if (missing.length > 0) {
		const labels = missing
			.map((key) => schema.value.find((field) => field.key === key)?.label ?? key)
			.join(', ');
		showToast(t('dashboard.admin.instance.plugins.detail.toasts.fillRequired', { fields: labels }));
		return;
	}
	const changes = pluginSettingsChanges(schema.value, form.value, baseline.value);
	const res = await setPluginSettings({ pluginId: pluginId.value, values: changes });
	if (res === undefined) return; // failure already toasted
	// Seed from the returned redacted state synchronously, not via a live-query
	// round-trip, so edits typed before the refresh arrives are not clobbered.
	seedForm(res);
	showToast(t('dashboard.admin.instance.plugins.detail.toasts.saved'));
}

// Both confirm paths run the same reset mutation but report different outcomes:
// the in-form reset restores schema defaults, while the orphan path is a purge
// (the plugin is gone — there are no defaults), matching the index page's copy.
async function reset(successMessage: string) {
	showResetConfirm.value = false;
	showOrphanClearConfirm.value = false;
	const res = await resetPluginSettings({ pluginId: pluginId.value });
	if (res === undefined) return;
	seedForm(res);
	showToast(successMessage);
}
function confirmReset() {
	return reset(t('dashboard.admin.instance.plugins.detail.toasts.reset'));
}
function confirmOrphanClear() {
	return reset(t('dashboard.admin.instance.plugins.detail.toasts.cleared', { pluginId: pluginId.value }));
}
</script>

<template>
	<div class="p-6 lg:p-8 max-w-3xl mx-auto">
		<NuxtLink
			to="/dashboard/admin/instance/plugins"
			class="inline-flex items-center gap-1.5 text-sm text-text-secondary hover:text-brand mb-4"
		>
			<Icon name="lucide:arrow-left" class="w-4 h-4" />
			{{ t('dashboard.admin.instance.plugins.detail.allPlugins') }}
		</NuxtLink>

		<UiQueryBoundary :loading="isLoading && !overview" :error="error">
			<!-- Uninstalled plugin with residual settings: purge-only state. -->
			<UiCard v-if="isOrphaned">
				<UiEmptyState
					icon="lucide:puzzle"
					:title="t('dashboard.admin.instance.plugins.detail.orphaned.title', { pluginId })"
					:description="t('dashboard.admin.instance.plugins.detail.orphaned.description')"
				>
					<UiButton
						variant="secondary"
						:loading="isResetting"
						@click="showOrphanClearConfirm = true"
					>
						{{ t('dashboard.admin.instance.plugins.detail.orphaned.clear') }}
					</UiButton>
				</UiEmptyState>
			</UiCard>

			<!-- Unknown plugin id. -->
			<UiCard v-else-if="!manifest || !entry">
				<UiEmptyState
					icon="lucide:puzzle"
					:title="t('dashboard.admin.instance.plugins.detail.notFound.title')"
					:description="t('dashboard.admin.instance.plugins.detail.notFound.description')"
				>
					<UiButton variant="secondary" to="/dashboard/admin/instance/plugins">{{
						t('dashboard.admin.instance.plugins.detail.notFound.back')
					}}</UiButton>
				</UiEmptyState>
			</UiCard>

			<template v-else>
				<!-- Header -->
				<div class="mb-6">
					<div class="flex items-center gap-2 flex-wrap">
						<h1 class="text-2xl font-medium tracking-[-0.02em] text-text-primary">{{ entry.pluginId }}</h1>
						<UiBadge :variant="entry.enabled ? 'success' : 'neutral'" dot>
							{{ entry.enabled ? t('common.enabled') : t('common.disabled') }}
						</UiBadge>
					</div>
					<p class="mt-1 text-text-secondary">
						{{
							t('dashboard.admin.instance.plugins.detail.packageVersion', {
								packageName: entry.packageName,
								version: entry.version,
							})
						}}
					</p>
				</div>

				<!-- Disabled notice -->
				<div
					v-if="!entry.enabled"
					class="mb-6 flex items-start gap-3 rounded-lg bg-bg-surface border border-border-subtle p-4"
				>
					<Icon name="lucide:power-off" class="w-5 h-5 text-text-tertiary shrink-0 mt-0.5" />
					<I18nT
						keypath="dashboard.admin.instance.plugins.detail.disabledNotice"
						tag="p"
						scope="global"
						class="text-sm text-text-secondary"
					>
						<template #featuresLink>
							<NuxtLink to="/dashboard/admin/instance/features" class="text-brand hover:underline">{{
								t('dashboard.admin.instance.plugins.detail.featuresLink')
							}}</NuxtLink>
						</template>
					</I18nT>
				</div>

				<div class="space-y-8">
					<!-- Capabilities & grants -->
					<UiCard padding="none" overflow="hidden">
						<template #header>
							<div class="flex items-center gap-3">
								<UiIconBox icon="lucide:shield-check" size="sm" variant="surface" rounded="lg" />
								<div>
									<h2 class="text-lg font-semibold text-text-primary">
										{{ t('dashboard.admin.instance.plugins.detail.capabilities.title') }}
									</h2>
									<p class="text-sm text-text-secondary">
										{{ t('dashboard.admin.instance.plugins.detail.capabilities.description') }}
									</p>
								</div>
							</div>
						</template>
						<div v-if="entry.capabilities.length > 0" class="divide-y divide-border-subtle">
							<div
								v-for="capability in entry.capabilities"
								:key="capability.capability"
								class="px-6 py-3 flex items-center justify-between gap-4"
							>
								<code class="text-sm text-text-secondary">{{ capability.capability }}</code>
								<UiBadge :variant="capability.granted ? 'success' : 'neutral'">
									{{
										capability.granted
											? t('dashboard.admin.instance.plugins.detail.capabilities.granted')
											: t('dashboard.admin.instance.plugins.detail.capabilities.notGranted')
									}}
								</UiBadge>
							</div>
						</div>
						<div v-else class="px-6 py-4 text-sm text-text-tertiary">
							{{ t('dashboard.admin.instance.plugins.detail.capabilities.none') }}
						</div>
					</UiCard>

					<!-- Settings form -->
					<UiCard padding="none" overflow="hidden">
						<template #header>
							<div class="flex items-center gap-3">
								<UiIconBox
									icon="lucide:sliders-horizontal"
									size="sm"
									variant="surface"
									rounded="lg"
								/>
								<div>
									<h2 class="text-lg font-semibold text-text-primary">
										{{ t('dashboard.admin.instance.plugins.detail.settings.title') }}
									</h2>
									<p class="text-sm text-text-secondary">
										{{ t('dashboard.admin.instance.plugins.detail.settings.description') }}
									</p>
								</div>
							</div>
						</template>

						<div v-if="schema.length === 0" class="px-6 py-6 text-sm text-text-tertiary">
							{{ t('dashboard.admin.instance.plugins.detail.settings.none') }}
						</div>

						<form v-else class="p-6" @submit.prevent="save">
							<!-- Deployment precondition, not a form error: the settings below stay
							     editable and saveable while these variables are unset. -->
							<div
								v-if="unsetSecrets.length > 0"
								class="mb-5 flex items-start gap-3 rounded-lg bg-bg-surface border border-border-subtle p-4"
								role="status"
							>
								<Icon name="lucide:key-round" class="w-5 h-5 text-text-tertiary shrink-0 mt-0.5" />
								<div class="text-sm text-text-secondary">
									<p>{{ t('dashboard.admin.instance.plugins.detail.settings.envVarsNotice', unsetSecrets.length) }}</p>
									<ul class="mt-1.5 space-y-0.5">
										<li v-for="secret in unsetSecrets" :key="secret.key">
											<code class="text-xs text-text-tertiary">{{ secret.envVar }}</code>
											<span class="text-text-tertiary">
												{{ t('dashboard.admin.instance.plugins.detail.settings.secretLabelSuffix', { label: secret.label }) }}</span
											>
										</li>
									</ul>
								</div>
							</div>

							<div class="space-y-5">
								<PluginSettingsField
									v-for="field in schema"
									:key="field.key"
									:field="field"
									:model-value="form[field.key] ?? ''"
									:secret-set="serverState.secretsSet[field.key] === true"
									:disabled="isSaving || isResetting"
									@update:model-value="form[field.key] = $event"
								/>
							</div>

							<div
								class="flex items-center justify-between gap-3 pt-6 mt-6 border-t border-border-subtle"
							>
								<UiButton
									type="button"
									variant="ghost"
									:disabled="isSaving || isResetting"
									@click="showResetConfirm = true"
								>
									{{ t('dashboard.admin.instance.plugins.detail.settings.resetToDefaults') }}
								</UiButton>
								<UiButton type="submit" :loading="isSaving" :disabled="!isDirty || isResetting">
									{{ t('dashboard.admin.instance.plugins.detail.settings.save') }}
								</UiButton>
							</div>
						</form>
					</UiCard>
				</div>
			</template>
		</UiQueryBoundary>

		<UiConfirmationDialog
			:open="showResetConfirm"
			variant="warning"
			:title="t('dashboard.admin.instance.plugins.detail.resetConfirm.title')"
			:description="t('dashboard.admin.instance.plugins.detail.resetConfirm.description')"
			:confirm-text="t('dashboard.admin.instance.plugins.detail.resetConfirm.confirm')"
			:cancel-text="t('common.cancel')"
			:is-loading="isResetting"
			@update:open="(v: boolean) => (showResetConfirm = v)"
			@confirm="confirmReset"
		/>

		<UiConfirmationDialog
			:open="showOrphanClearConfirm"
			variant="warning"
			:title="t('dashboard.admin.instance.plugins.detail.orphanClearConfirm.title')"
			:description="t('dashboard.admin.instance.plugins.detail.orphanClearConfirm.description')"
			:confirm-text="t('dashboard.admin.instance.plugins.detail.orphanClearConfirm.confirm')"
			:cancel-text="t('common.cancel')"
			:is-loading="isResetting"
			@update:open="(v: boolean) => (showOrphanClearConfirm = v)"
			@confirm="confirmOrphanClear"
		/>
	</div>
</template>
