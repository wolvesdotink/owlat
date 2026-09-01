<script setup lang="ts">
import { api } from '@owlat/api';
import {
	OPERATING_MODES,
	OPERATING_MODE_KEYS,
	operatingModeFlags,
	type OperatingModeKey,
} from '@owlat/shared/operatingModes';
import { bundledPluginComposition } from '~/plugins/plugin-composition.generated';
import type { CoreFeatureFlagKey } from '@owlat/shared/featureFlags';

const { t } = useI18n();

useHead({ title: () => t('dashboard.admin.instance.index.pageTitle') });
definePageMeta({ layout: 'admin', middleware: ['auth', 'admin'] });

const { flags, isEnabled } = useFeatureFlag();
const { data: pluginSettingsOverview } = useConvexQuery(
	api.plugins.settings.getPluginSettingsOverview,
	() => (bundledPluginComposition.length === 0 ? {} : 'skip')
);
const hasPluginSettings = computed(
	() =>
		bundledPluginComposition.length > 0 || (pluginSettingsOverview.value?.orphaned.length ?? 0) > 0
);
const selectedMode = ref<OperatingModeKey | null>(null);
const modesOpen = ref(false);
const { showToast } = useToast();
const { run: setAllFlags, isLoading: applyingMode } = useBackendOperation(
	api.workspaces.featureFlags.setAllFeatureFlags,
	{ label: () => t('dashboard.admin.instance.index.changeModeOperation') }
);

const desiredFlags = computed(() =>
	selectedMode.value ? operatingModeFlags(selectedMode.value) : null
);
const flagDiff = computed(() => {
	const desired = desiredFlags.value;
	if (!desired) return { enabled: [] as string[], disabled: [] as string[] };
	const enabled: string[] = [];
	const disabled: string[] = [];
	for (const key of Object.keys(desired) as CoreFeatureFlagKey[]) {
		const value = desired[key];
		const current = flags.value[key] === true;
		if (value && !current) enabled.push(key);
		if (!value && current) disabled.push(key);
	}
	return { enabled, disabled };
});

function chooseMode(key: OperatingModeKey) {
	selectedMode.value = key;
}

async function applyMode() {
	if (!selectedMode.value || !desiredFlags.value) return;
	const result = await setAllFlags({ flags: desiredFlags.value });
	if (!result.ok) return;
	showToast(
		t('dashboard.admin.instance.index.modeChangedToast', {
			mode: t(OPERATING_MODES[selectedMode.value].label),
		})
	);
	selectedMode.value = null;
	modesOpen.value = false;
}

const groups = computed(() => [
	{
		title: t('dashboard.admin.instance.index.groups.general.title'),
		description: t('dashboard.admin.instance.index.groups.general.description'),
		href: '/dashboard/admin/instance/general',
		icon: 'lucide:building-2',
	},
	{
		title: t('dashboard.admin.instance.index.groups.features.title'),
		description: t('dashboard.admin.instance.index.groups.features.description'),
		href: '/dashboard/admin/instance/features',
		icon: 'lucide:toggle-right',
	},
	{
		title: t('dashboard.admin.instance.index.groups.emailTheme.title'),
		description: t('dashboard.admin.instance.index.groups.emailTheme.description'),
		href: '/dashboard/admin/instance/email-theme',
		icon: 'lucide:palette',
	},
	{
		title: t('dashboard.admin.instance.index.groups.properties.title'),
		description: t('dashboard.admin.instance.index.groups.properties.description'),
		href: '/dashboard/admin/instance/properties',
		icon: 'lucide:tags',
	},
	{
		title: t('dashboard.admin.instance.index.groups.forms.title'),
		description: t('dashboard.admin.instance.index.groups.forms.description'),
		href: '/dashboard/admin/instance/forms',
		icon: 'lucide:file-text',
	},
	{
		title: t('dashboard.admin.instance.index.groups.channels.title'),
		description: t('dashboard.admin.instance.index.groups.channels.description'),
		href: '/dashboard/admin/instance/channels',
		icon: 'lucide:radio',
	},
	{
		title: t('dashboard.admin.instance.index.groups.aiProvider.title'),
		description: t('dashboard.admin.instance.index.groups.aiProvider.description'),
		href: '/dashboard/admin/instance/ai-provider',
		icon: 'lucide:sparkles',
	},
	...(isEnabled('ai.agent')
		? [
				{
					title: t('dashboard.admin.instance.index.groups.agent.title'),
					description: t('dashboard.admin.instance.index.groups.agent.description'),
					href: '/dashboard/admin/instance/agent',
					icon: 'lucide:bot',
				},
				{
					title: t('dashboard.admin.instance.index.groups.agentHealth.title'),
					description: t('dashboard.admin.instance.index.groups.agentHealth.description'),
					href: '/dashboard/admin/instance/agent-health',
					icon: 'lucide:activity',
				},
			]
		: []),
	// Autonomy carries the kill switch, so it must stay one click from here
	// whenever the flag that unlocks the page is on (the page mirrors this gate
	// with `requiresFeature: 'ai.autonomy'`).
	...(isEnabled('ai.autonomy')
		? [
				{
					title: t('dashboard.admin.instance.index.groups.autonomy.title'),
					description: t('dashboard.admin.instance.index.groups.autonomy.description'),
					href: '/dashboard/admin/instance/autonomy',
					icon: 'lucide:sliders-horizontal',
				},
			]
		: []),
	...(isEnabled('sealedMail')
		? [
				{
					title: t('dashboard.admin.instance.index.groups.sealedMail.title'),
					description: t('dashboard.admin.instance.index.groups.sealedMail.description'),
					href: '/dashboard/admin/instance/sealed-mail',
					icon: 'lucide:lock',
				},
			]
		: []),
	...(hasPluginSettings.value
		? [
				{
					title: t('dashboard.admin.instance.index.groups.plugins.title'),
					description: t('dashboard.admin.instance.index.groups.plugins.description'),
					href: '/dashboard/admin/instance/plugins',
					icon: 'lucide:puzzle',
				},
			]
		: []),
]);
</script>

<template>
	<div class="p-6 lg:p-8 max-w-6xl">
		<header class="mb-8">
			<h1 class="text-3xl font-semibold text-text-primary">
				{{ t('dashboard.admin.instance.index.title') }}
			</h1>
			<p class="mt-2 text-text-secondary">
				{{ t('dashboard.admin.instance.index.subtitle') }}
			</p>
		</header>

		<UiCard class="mb-6">
			<h2 class="text-lg font-semibold text-text-primary">
				{{ t('dashboard.admin.instance.index.operatingMode') }}
			</h2>
			<p class="mt-1 mb-4 text-sm text-text-secondary max-w-2xl">
				{{ t('dashboard.admin.instance.index.operatingModeHelp') }}
			</p>
			<UiDisclosure
				v-model="modesOpen"
				controls="operating-mode-options"
				:label="t('dashboard.admin.instance.index.changeModeOperation')"
			>
				<div class="grid gap-3 md:grid-cols-2">
					<button
						v-for="key in OPERATING_MODE_KEYS"
						:key="key"
						type="button"
						class="text-left rounded-xl border border-border-subtle p-4 hover:border-brand hover:bg-brand-subtle transition-colors"
						@click="chooseMode(key)"
					>
						<span class="font-medium text-text-primary">{{ t(OPERATING_MODES[key].label) }}</span>
						<span class="mt-1 block text-xs text-text-secondary">{{
							t(OPERATING_MODES[key].audience)
						}}</span>
					</button>
				</div>
			</UiDisclosure>
		</UiCard>

		<div class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
			<NuxtLink v-for="group in groups" :key="group.href" :to="group.href" class="group">
				<UiCard hoverable class="h-full">
					<div class="flex items-start gap-3">
						<UiIconBox :icon="group.icon" size="sm" variant="surface" rounded="lg" />
						<div>
							<h2 class="font-semibold text-text-primary">{{ group.title }}</h2>
							<p class="mt-1 text-sm text-text-secondary">{{ group.description }}</p>
						</div>
					</div>
				</UiCard>
			</NuxtLink>
		</div>

		<UiModal
			:open="selectedMode !== null"
			:title="t('dashboard.admin.instance.index.reviewTitle')"
			size="md"
			@update:open="
				(open) => {
					if (!open) selectedMode = null;
				}
			"
		>
			<div v-if="selectedMode" class="space-y-4">
				<div>
					<p class="font-medium text-text-primary">{{ t(OPERATING_MODES[selectedMode].label) }}</p>
					<p class="mt-1 text-sm text-text-secondary">
						{{ t(OPERATING_MODES[selectedMode].description) }}
					</p>
				</div>
				<div class="grid gap-3 sm:grid-cols-2">
					<div class="rounded-lg bg-success-subtle p-3">
						<p class="text-sm font-medium text-success">
							{{
								t('dashboard.admin.instance.index.enableCount', { count: flagDiff.enabled.length })
							}}
						</p>
						<p class="mt-1 text-xs text-text-secondary break-words">
							{{ flagDiff.enabled.join(', ') || t('dashboard.admin.instance.index.nothing') }}
						</p>
					</div>
					<div class="rounded-lg bg-warning-subtle p-3">
						<p class="text-sm font-medium text-warning">
							{{
								t('dashboard.admin.instance.index.disableCount', {
									count: flagDiff.disabled.length,
								})
							}}
						</p>
						<p class="mt-1 text-xs text-text-secondary break-words">
							{{ flagDiff.disabled.join(', ') || t('dashboard.admin.instance.index.nothing') }}
						</p>
					</div>
				</div>
				<p class="text-xs text-text-tertiary">
					{{ t('dashboard.admin.instance.index.keepData') }}
				</p>
			</div>
			<template #footer>
				<UiButton variant="ghost" @click="selectedMode = null">{{ t('common.cancel') }}</UiButton>
				<UiButton :loading="applyingMode" @click="applyMode">{{
					t('dashboard.admin.instance.index.applyChanges')
				}}</UiButton>
			</template>
		</UiModal>
	</div>
</template>
