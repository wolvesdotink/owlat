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

useHead({ title: 'Instance administration — Owlat' });
definePageMeta({ layout: 'dashboard', middleware: ['auth', 'admin'] });

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
	{ label: 'Change operating mode' }
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
	if (result === undefined) return;
	showToast(`Operating mode changed to ${OPERATING_MODES[selectedMode.value].label}`);
	selectedMode.value = null;
	modesOpen.value = false;
}

const groups = computed(() => [
	{
		title: 'General',
		description: 'Workspace name, timezone, default sender, and campaign defaults.',
		href: '/dashboard/admin/instance/general',
		icon: 'lucide:building-2',
	},
	{
		title: 'Features',
		description: 'Fine-grained feature flags and packs for advanced configuration.',
		href: '/dashboard/admin/instance/features',
		icon: 'lucide:toggle-right',
	},
	{
		title: 'Email theme',
		description: 'Default visual styling for messages sent by this workspace.',
		href: '/dashboard/admin/instance/email-theme',
		icon: 'lucide:palette',
	},
	{
		title: 'Contact properties',
		description: 'Custom fields shared by the customer directory.',
		href: '/dashboard/admin/instance/properties',
		icon: 'lucide:tags',
	},
	{
		title: 'Forms',
		description: 'Signup endpoints and embedded customer forms.',
		href: '/dashboard/admin/instance/forms',
		icon: 'lucide:file-text',
	},
	{
		title: 'Channels',
		description: 'Messaging channels available across the instance.',
		href: '/dashboard/admin/instance/channels',
		icon: 'lucide:radio',
	},
	{
		title: 'AI provider',
		description: 'Choose the hosted or self-run model provider and turn AI on.',
		href: '/dashboard/admin/instance/ai-provider',
		icon: 'lucide:sparkles',
	},
	...(isEnabled('ai.agent')
		? [
				{
					title: 'AI agent',
					description: 'Configure the organization-wide agent and inspect its health.',
					href: '/dashboard/admin/instance/agent',
					icon: 'lucide:bot',
				},
				{
					title: 'Agent health',
					description: 'Live accuracy, escalations, and recent agent runs.',
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
					title: 'Autonomy',
					description: 'How much the agent may act on its own, and the switch that stops it.',
					href: '/dashboard/admin/instance/autonomy',
					icon: 'lucide:sliders-horizontal',
				},
			]
		: []),
	...(isEnabled('sealedMail')
		? [
				{
					title: 'Secure mail',
					description: 'Set organization policy for protected personal messages.',
					href: '/dashboard/admin/instance/sealed-mail',
					icon: 'lucide:lock',
				},
			]
		: []),
	...(hasPluginSettings.value
		? [
				{
					title: 'Plugins',
					description: 'Configure installed plugins or remove settings left by old ones.',
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
			<NuxtLink to="/dashboard/admin" class="text-sm text-brand hover:underline">
				← Administration
			</NuxtLink>
			<h1 class="mt-3 text-3xl font-semibold text-text-primary">Instance</h1>
			<p class="mt-2 text-text-secondary">Configuration that affects everyone in this workspace.</p>
		</header>

		<UiCard class="mb-6">
			<h2 class="text-lg font-semibold text-text-primary">Operating mode</h2>
			<p class="mt-1 mb-4 text-sm text-text-secondary max-w-2xl">
				Choose a coarse product shape. You will preview every feature change before it is applied,
				and turning a feature off keeps its data.
			</p>
			<UiDisclosure
				v-model="modesOpen"
				controls="operating-mode-options"
				label="Change operating mode"
			>
				<div class="grid gap-3 md:grid-cols-2">
					<button
						v-for="key in OPERATING_MODE_KEYS"
						:key="key"
						type="button"
						class="text-left rounded-xl border border-border-subtle p-4 hover:border-brand hover:bg-brand-subtle transition-colors"
						@click="chooseMode(key)"
					>
						<span class="font-medium text-text-primary">{{ OPERATING_MODES[key].label }}</span>
						<span class="mt-1 block text-xs text-text-secondary">{{
							OPERATING_MODES[key].audience
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
			title="Review operating-mode changes"
			size="md"
			@update:open="
				(open) => {
					if (!open) selectedMode = null;
				}
			"
		>
			<div v-if="selectedMode" class="space-y-4">
				<div>
					<p class="font-medium text-text-primary">{{ OPERATING_MODES[selectedMode].label }}</p>
					<p class="mt-1 text-sm text-text-secondary">
						{{ OPERATING_MODES[selectedMode].description }}
					</p>
				</div>
				<div class="grid gap-3 sm:grid-cols-2">
					<div class="rounded-lg bg-success-subtle p-3">
						<p class="text-sm font-medium text-success">Enable ({{ flagDiff.enabled.length }})</p>
						<p class="mt-1 text-xs text-text-secondary break-words">
							{{ flagDiff.enabled.join(', ') || 'Nothing' }}
						</p>
					</div>
					<div class="rounded-lg bg-warning-subtle p-3">
						<p class="text-sm font-medium text-warning">Disable ({{ flagDiff.disabled.length }})</p>
						<p class="mt-1 text-xs text-text-secondary break-words">
							{{ flagDiff.disabled.join(', ') || 'Nothing' }}
						</p>
					</div>
				</div>
				<p class="text-xs text-text-tertiary">Disabled features keep their existing data.</p>
			</div>
			<template #footer>
				<UiButton variant="ghost" @click="selectedMode = null">Cancel</UiButton>
				<UiButton :loading="applyingMode" @click="applyMode">Apply changes</UiButton>
			</template>
		</UiModal>
	</div>
</template>
