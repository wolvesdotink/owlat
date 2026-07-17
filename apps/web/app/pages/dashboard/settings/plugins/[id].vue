<script setup lang="ts">
import { api } from '@owlat/api';
import { bundledPluginComposition } from '~/plugins/plugin-composition.generated';
import PluginSettingsField from '~/components/settings/PluginSettingsField.vue';
import {
	hasPluginSettingsChanges,
	missingRequiredPluginSettings,
	pluginSettingsBaseline,
	pluginSettingsChanges,
	type PluginSettingsForm,
	type PluginSettingsRedactedState,
} from '~/utils/pluginSettings';

definePageMeta({ layout: 'dashboard', middleware: 'auth' });

const route = useRoute();
const pluginId = computed(() => String(route.params['id']));

const manifest = computed(
	() => bundledPluginComposition.find((plugin) => plugin.manifest.id === pluginId.value)?.manifest
);
const schema = computed(() => manifest.value?.settingsSchema ?? []);

useHead(() => ({ title: `${pluginId.value} — Plugins — Owlat` }));

const {
	data: overview,
	isLoading,
	error,
} = useConvexQuery(api.plugins.settings.getPluginSettingsOverview, {});

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
	{ label: 'Save plugin settings' }
);
const { run: resetPluginSettings, isLoading: isResetting } = useBackendOperation(
	api.plugins.settings.resetPluginSettings,
	{ label: 'Reset plugin settings' }
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
// Both destructive paths (in-form "Reset to defaults" and the orphaned-plugin
// "Clear residual settings") confirm before invoking reset(), so a single
// misclick can never wipe stored values, including saved secrets.
const showResetConfirm = ref(false);
const showOrphanClearConfirm = ref(false);

async function save() {
	const missing = missingRequiredPluginSettings(schema.value, form.value, serverState.value);
	if (missing.length > 0) {
		const labels = missing
			.map((key) => schema.value.find((field) => field.key === key)?.label ?? key)
			.join(', ');
		showToast(`Fill in the required fields: ${labels}`);
		return;
	}
	const changes = pluginSettingsChanges(schema.value, form.value, baseline.value);
	const res = await setPluginSettings({ pluginId: pluginId.value, values: changes });
	if (res === undefined) return; // failure already toasted
	// Seed from the returned redacted state synchronously, not via a live-query
	// round-trip, so edits typed before the refresh arrives are not clobbered.
	seedForm(res);
	showToast('Plugin settings saved.');
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
	return reset('Plugin settings reset to defaults.');
}
function confirmOrphanClear() {
	return reset(`Cleared residual settings for ${pluginId.value}.`);
}
</script>

<template>
	<div class="p-6 lg:p-8 max-w-3xl mx-auto">
		<NuxtLink
			to="/dashboard/settings/plugins"
			class="inline-flex items-center gap-1.5 text-sm text-text-secondary hover:text-brand mb-4"
		>
			<Icon name="lucide:arrow-left" class="w-4 h-4" />
			All plugins
		</NuxtLink>

		<UiQueryBoundary :loading="isLoading && !overview" :error="error">
			<!-- Uninstalled plugin with residual settings: purge-only state. -->
			<UiCard v-if="isOrphaned">
				<UiEmptyState
					icon="lucide:puzzle"
					:title="`${pluginId} is no longer installed`"
					description="This plugin was removed from the build but left stored settings behind. Clear them to remove any saved values, including secrets."
				>
					<UiButton
						variant="secondary"
						:loading="isResetting"
						@click="showOrphanClearConfirm = true"
					>
						Clear residual settings
					</UiButton>
				</UiEmptyState>
			</UiCard>

			<!-- Unknown plugin id. -->
			<UiCard v-else-if="!manifest || !entry">
				<UiEmptyState
					icon="lucide:puzzle"
					title="Plugin not found"
					description="No installed plugin matches this address."
				>
					<UiButton variant="secondary" to="/dashboard/settings/plugins">Back to plugins</UiButton>
				</UiEmptyState>
			</UiCard>

			<template v-else>
				<!-- Header -->
				<div class="mb-6">
					<div class="flex items-center gap-2 flex-wrap">
						<h1 class="text-2xl font-semibold text-text-primary">{{ entry.pluginId }}</h1>
						<UiBadge :variant="entry.enabled ? 'success' : 'neutral'" dot>
							{{ entry.enabled ? 'Enabled' : 'Disabled' }}
						</UiBadge>
					</div>
					<p class="mt-1 text-text-secondary">{{ entry.packageName }} · v{{ entry.version }}</p>
				</div>

				<!-- Disabled notice -->
				<div
					v-if="!entry.enabled"
					class="mb-6 flex items-start gap-3 rounded-lg bg-bg-surface border border-border-subtle p-4"
				>
					<Icon name="lucide:power-off" class="w-5 h-5 text-text-tertiary shrink-0 mt-0.5" />
					<p class="text-sm text-text-secondary">
						This plugin is disabled. You can configure its settings now; enable it and approve its
						capabilities under
						<NuxtLink to="/dashboard/settings/features" class="text-brand hover:underline"
							>Features</NuxtLink
						>.
					</p>
				</div>

				<div class="space-y-8">
					<!-- Capabilities & grants -->
					<UiCard padding="none" overflow="hidden">
						<template #header>
							<div class="flex items-center gap-3">
								<UiIconBox icon="lucide:shield-check" size="sm" variant="surface" rounded="lg" />
								<div>
									<h2 class="text-lg font-semibold text-text-primary">Capabilities</h2>
									<p class="text-sm text-text-secondary">
										Host-mediated operations this plugin declared, and whether the operator has
										granted each.
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
									{{ capability.granted ? 'Granted' : 'Not granted' }}
								</UiBadge>
							</div>
						</div>
						<div v-else class="px-6 py-4 text-sm text-text-tertiary">
							This plugin requests no capabilities.
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
									<h2 class="text-lg font-semibold text-text-primary">Settings</h2>
									<p class="text-sm text-text-secondary">
										Configuration this plugin exposes. Secrets are stored securely and never shown.
									</p>
								</div>
							</div>
						</template>

						<div v-if="schema.length === 0" class="px-6 py-6 text-sm text-text-tertiary">
							This plugin has no configurable settings.
						</div>

						<form v-else class="p-6" @submit.prevent="save">
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
									Reset to defaults
								</UiButton>
								<UiButton type="submit" :loading="isSaving" :disabled="!isDirty || isResetting">
									Save settings
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
			title="Reset plugin settings?"
			description="This clears every stored value for this plugin, including saved secrets, and returns it to the schema defaults."
			confirm-text="Reset"
			cancel-text="Cancel"
			:is-loading="isResetting"
			@update:open="(v: boolean) => (showResetConfirm = v)"
			@confirm="confirmReset"
		/>

		<UiConfirmationDialog
			:open="showOrphanClearConfirm"
			variant="warning"
			title="Clear residual settings?"
			description="This permanently removes the stored settings this uninstalled plugin left behind, including any saved secrets. This cannot be undone."
			confirm-text="Clear settings"
			cancel-text="Cancel"
			:is-loading="isResetting"
			@update:open="(v: boolean) => (showOrphanClearConfirm = v)"
			@confirm="confirmOrphanClear"
		/>
	</div>
</template>
