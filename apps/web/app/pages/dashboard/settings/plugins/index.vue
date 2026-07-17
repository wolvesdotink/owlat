<script setup lang="ts">
import { api } from '@owlat/api';
import { bundledPluginComposition } from '~/plugins/plugin-composition.generated';

useHead({ title: 'Plugins — Owlat' });
definePageMeta({ layout: 'dashboard', middleware: 'auth' });

// Build-time bundled manifests: the authoritative source for names, versions,
// capabilities, and settings schemas. The server overrides only mutable state.
const manifests = bundledPluginComposition;

const {
	data: overview,
	isLoading,
	error,
} = useConvexQuery(api.plugins.settings.getPluginSettingsOverview, {});

const { showToast } = useToast();
const { run: resetPluginSettings, isLoading: isPurging } = useBackendOperation(
	api.plugins.settings.resetPluginSettings,
	{ label: 'Clear plugin settings' }
);

const plugins = computed(() => overview.value?.plugins ?? []);
const orphaned = computed(() => overview.value?.orphaned ?? []);

const purgeTarget = ref<string | null>(null);

async function confirmPurge() {
	if (!purgeTarget.value) return;
	const pluginId = purgeTarget.value;
	const res = await resetPluginSettings({ pluginId });
	purgeTarget.value = null;
	if (res === undefined) return; // failure already toasted by the operation module
	showToast(`Cleared residual settings for ${pluginId}.`);
}
</script>

<template>
	<div class="p-6 lg:p-8 max-w-4xl mx-auto">
		<div class="mb-8">
			<h1 class="text-2xl font-semibold text-text-primary">Plugins</h1>
			<p class="mt-1 text-text-secondary max-w-2xl">
				Configure each installed plugin. Enabling a plugin and approving the capabilities it
				requests happens under
				<NuxtLink to="/dashboard/settings/features" class="text-brand hover:underline"
					>Features</NuxtLink
				>; this page manages each plugin's own settings.
			</p>
		</div>

		<UiQueryBoundary :loading="isLoading && !overview" :error="error">
			<div class="space-y-8">
				<UiCard v-if="manifests.length === 0">
					<UiEmptyState
						icon="lucide:puzzle"
						title="No plugins installed"
						description="Bundled plugins are added to this deployment's build. Once a plugin is installed it appears here to configure."
					/>
				</UiCard>

				<div v-else class="grid gap-4">
					<NuxtLink
						v-for="plugin in plugins"
						:key="plugin.pluginId"
						:to="`/dashboard/settings/plugins/${plugin.pluginId}`"
						class="group"
					>
						<UiCard hoverable>
							<div class="flex items-center justify-between gap-4">
								<div class="min-w-0">
									<div class="flex items-center gap-2 flex-wrap">
										<h2 class="text-lg font-medium text-text-primary">{{ plugin.pluginId }}</h2>
										<UiBadge :variant="plugin.enabled ? 'success' : 'neutral'" dot>
											{{ plugin.enabled ? 'Enabled' : 'Disabled' }}
										</UiBadge>
									</div>
									<p class="text-sm text-text-secondary mt-0.5 truncate">
										{{ plugin.packageName }} · v{{ plugin.version }}
									</p>
									<p class="text-xs text-text-tertiary mt-1">
										{{ plugin.capabilities.length }}
										{{ plugin.capabilities.length === 1 ? 'capability' : 'capabilities' }}
										<template v-if="plugin.hasSettings"> · configurable settings </template>
									</p>
								</div>
								<Icon
									name="lucide:chevron-right"
									class="w-5 h-5 text-text-tertiary group-hover:text-brand transition-colors shrink-0"
								/>
							</div>
						</UiCard>
					</NuxtLink>
				</div>

				<!-- Residual settings left by a plugin removed from the build. -->
				<UiCard v-if="orphaned.length > 0" padding="none" overflow="hidden">
					<template #header>
						<div class="flex items-center gap-3">
							<UiIconBox icon="lucide:trash-2" size="sm" variant="surface" rounded="lg" />
							<div>
								<h2 class="text-lg font-semibold text-text-primary">Residual settings</h2>
								<p class="text-sm text-text-secondary">
									These plugins are no longer installed. Their stored settings can be cleared.
								</p>
							</div>
						</div>
					</template>
					<div class="divide-y divide-border-subtle">
						<div
							v-for="entry in orphaned"
							:key="entry.flagKey"
							class="px-6 py-4 flex items-center justify-between gap-4"
						>
							<code class="text-sm text-text-secondary">{{ entry.pluginId }}</code>
							<UiButton
								variant="secondary"
								size="sm"
								:disabled="isPurging"
								@click="purgeTarget = entry.pluginId"
							>
								Clear settings
							</UiButton>
						</div>
					</div>
				</UiCard>
			</div>
		</UiQueryBoundary>

		<UiConfirmationDialog
			:open="!!purgeTarget"
			variant="warning"
			:title="purgeTarget ? `Clear settings for ${purgeTarget}?` : 'Clear settings?'"
			description="This permanently removes the stored settings for this uninstalled plugin, including any saved secrets."
			confirm-text="Clear settings"
			cancel-text="Cancel"
			:is-loading="isPurging"
			@update:open="(v: boolean) => !v && (purgeTarget = null)"
			@confirm="confirmPurge"
		/>
	</div>
</template>
