<script setup lang="ts">
import { api } from '@owlat/api';
import { bundledPluginComposition } from '~/plugins/plugin-composition.generated';

const { t } = useI18n();

useHead({ title: () => t('dashboard.admin.instance.plugins.index.pageTitle') });
definePageMeta({ layout: 'admin', middleware: ['auth', 'admin'] });

// Build-time bundled manifests: the authoritative source for names, versions,
// capabilities, and settings schemas. The server overrides only mutable state.
const manifests = bundledPluginComposition;

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

const { showToast } = useToast();
const { run: resetPluginSettings, isLoading: isPurging } = useBackendOperation(
	api.plugins.settings.resetPluginSettings,
	{ label: () => t('dashboard.admin.instance.plugins.index.clearSettingsOperation') }
);

const plugins = computed(() => overview.value?.plugins ?? []);
const orphaned = computed(() => overview.value?.orphaned ?? []);

const purgeTarget = ref<string | null>(null);

async function confirmPurge() {
	if (!purgeTarget.value) return;
	const pluginId = purgeTarget.value;
	const res = await resetPluginSettings({ pluginId });
	purgeTarget.value = null;
	if (!res.ok) return; // failure already toasted by the operation module
	showToast(t('dashboard.admin.instance.plugins.index.toasts.cleared', { pluginId }));
}
</script>

<template>
	<div class="p-6 lg:p-8 max-w-4xl mx-auto">
		<div class="mb-8">
			<h1 class="text-2xl font-medium tracking-[-0.02em] text-text-primary">
				{{ t('dashboard.admin.instance.plugins.index.title') }}
			</h1>
			<I18nT
				keypath="dashboard.admin.instance.plugins.index.intro"
				tag="p"
				scope="global"
				class="mt-1 text-text-secondary max-w-2xl"
			>
				<template #featuresLink>
					<NuxtLink to="/dashboard/admin/instance/features" class="text-brand hover:underline">{{
						t('dashboard.admin.instance.plugins.index.featuresLink')
					}}</NuxtLink>
				</template>
			</I18nT>
		</div>

		<UiQueryBoundary :loading="isLoading && !overview" :error="error">
			<div class="space-y-8">
				<UiCard v-if="manifests.length === 0">
					<UiEmptyState
						icon="lucide:puzzle"
						:title="t('dashboard.admin.instance.plugins.index.empty.title')"
						:description="t('dashboard.admin.instance.plugins.index.empty.description')"
					/>
				</UiCard>

				<div v-else class="grid gap-4">
					<NuxtLink
						v-for="plugin in plugins"
						:key="plugin.pluginId"
						:to="`/dashboard/admin/instance/plugins/${plugin.pluginId}`"
						class="group"
					>
						<UiCard hoverable>
							<div class="flex items-center justify-between gap-4">
								<div class="min-w-0">
									<div class="flex items-center gap-2 flex-wrap">
										<h2 class="text-lg font-medium text-text-primary">{{ plugin.pluginId }}</h2>
										<UiBadge :variant="plugin.enabled ? 'success' : 'neutral'" dot>
											{{ plugin.enabled ? t('common.enabled') : t('common.disabled') }}
										</UiBadge>
									</div>
									<p class="text-sm text-text-secondary mt-0.5 truncate">
										{{
											t('dashboard.admin.instance.plugins.index.packageVersion', {
												packageName: plugin.packageName,
												version: plugin.version,
											})
										}}
									</p>
									<p class="text-xs text-text-tertiary mt-1">
										{{
											t(
												'dashboard.admin.instance.plugins.index.capabilityCount',
												plugin.capabilities.length
											)
										}}
										<template v-if="plugin.hasSettings">
											{{ t('dashboard.admin.instance.plugins.index.configurableSettings') }}
										</template>
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
								<h2 class="text-lg font-semibold text-text-primary">
									{{ t('dashboard.admin.instance.plugins.index.residual.title') }}
								</h2>
								<p class="text-sm text-text-secondary">
									{{ t('dashboard.admin.instance.plugins.index.residual.description') }}
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
								{{ t('dashboard.admin.instance.plugins.index.clearSettings') }}
							</UiButton>
						</div>
					</div>
				</UiCard>
			</div>
		</UiQueryBoundary>

		<UiConfirmationDialog
			:open="!!purgeTarget"
			variant="warning"
			:title="
				purgeTarget
					? t('dashboard.admin.instance.plugins.index.confirm.title', { pluginId: purgeTarget })
					: t('dashboard.admin.instance.plugins.index.confirm.titleFallback')
			"
			:description="t('dashboard.admin.instance.plugins.index.confirm.description')"
			:confirm-text="t('dashboard.admin.instance.plugins.index.clearSettings')"
			:cancel-text="t('common.cancel')"
			:is-loading="isPurging"
			@update:open="(v: boolean) => !v && (purgeTarget = null)"
			@confirm="confirmPurge"
		/>
	</div>
</template>
