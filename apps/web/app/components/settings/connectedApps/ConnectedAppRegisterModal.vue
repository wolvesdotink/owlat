<script setup lang="ts">
/**
 * Connected-app registration wizard (presentational). Progressive disclosure in
 * two steps: (1) which plugin + a name + the HTTPS hook endpoint; (2) the
 * capabilities to grant, shown only after the details validate, behind a fixed
 * Tier-2 risk disclosure. It owns no backend calls — it validates and emits a
 * `submit` payload; the parent runs the register action and reports back through
 * `is-submitting` / `error-message`.
 */
import { connectedAppCapabilityLabel } from '~/utils/connectedAppCapabilities';

const { t } = useI18n();

interface RegistrablePlugin {
	readonly pluginId: string;
	readonly capabilities: readonly string[];
}

const props = defineProps<{
	open: boolean;
	plugins: ReadonlyArray<RegistrablePlugin>;
	isSubmitting: boolean;
	/** Server-side failure text bound inline (e.g. a rejected endpoint). */
	errorMessage: string | null;
}>();

const emit = defineEmits<{
	close: [];
	submit: [
		payload: {
			pluginId: string;
			name: string;
			endpointUrl: string;
			grantedCapabilities: string[];
		},
	];
}>();

type Step = 'details' | 'capabilities';
const step = ref<Step>('details');

// Focus targets for the two steps. Swapping the step body/footer would otherwise
// drop keyboard/SR focus to <body> (WCAG 2.4.3); after a flip we move focus onto
// the newly disclosed content. Entering capabilities focuses the Tier-2 risk
// disclosure so it is announced BEFORE the capability checkboxes; going Back
// focuses the details step heading.
const riskRegion = ref<HTMLElement | null>(null);
const detailsHeading = ref<HTMLElement | null>(null);

async function focusStep(next: Step) {
	await nextTick();
	const target = next === 'capabilities' ? riskRegion.value : detailsHeading.value;
	target?.focus();
}

const pluginId = ref('');
const name = ref('');
const endpointUrl = ref('');
const selectedCapabilities = ref<string[]>([]);

// A local validation message for the details step (distinct from the server-side
// `errorMessage`, which is surfaced on the capabilities/submit step).
const detailsError = ref<string | null>(null);

const selectedPlugin = computed(() =>
	props.plugins.find((plugin) => plugin.pluginId === pluginId.value)
);
const availableCapabilities = computed(() => selectedPlugin.value?.capabilities ?? []);

// Reset the whole wizard whenever it (re)opens, preselecting the only plugin when
// there is exactly one so the common single-plugin deployment skips a dead choice.
watch(
	() => props.open,
	(open) => {
		if (!open) return;
		step.value = 'details';
		pluginId.value = props.plugins.length === 1 ? (props.plugins[0]?.pluginId ?? '') : '';
		name.value = '';
		endpointUrl.value = '';
		selectedCapabilities.value = [];
		detailsError.value = null;
	}
);

// Dropping the plugin selection drops any capabilities that plugin no longer offers.
watch(pluginId, () => {
	const allowed = new Set(availableCapabilities.value);
	selectedCapabilities.value = selectedCapabilities.value.filter((c) => allowed.has(c));
});

function isValidHttpsUrl(value: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		return false;
	}
	return parsed.protocol === 'https:' && !!parsed.hostname && !parsed.username && !parsed.password;
}

function goToCapabilities() {
	detailsError.value = null;
	if (!pluginId.value) {
		detailsError.value = t('components.settings.connectedApps.connectedAppRegisterModal.choosePluginError');
		return;
	}
	if (!name.value.trim()) {
		detailsError.value = t('components.settings.connectedApps.connectedAppRegisterModal.nameRequiredError');
		return;
	}
	if (!isValidHttpsUrl(endpointUrl.value.trim())) {
		detailsError.value = t('components.settings.connectedApps.connectedAppRegisterModal.endpointError');
		return;
	}
	step.value = 'capabilities';
	void focusStep('capabilities');
}

function goBack() {
	step.value = 'details';
	void focusStep('details');
}

function toggleCapability(capability: string) {
	const next = new Set(selectedCapabilities.value);
	if (next.has(capability)) next.delete(capability);
	else next.add(capability);
	selectedCapabilities.value = [...next];
}

function submit() {
	if (selectedCapabilities.value.length === 0) return;
	emit('submit', {
		pluginId: pluginId.value,
		name: name.value.trim(),
		endpointUrl: endpointUrl.value.trim(),
		grantedCapabilities: [...selectedCapabilities.value],
	});
}

const canSubmit = computed(
	() => selectedCapabilities.value.length > 0 && !props.isSubmitting
);
</script>

<template>
	<UiModal
		:open="open"
		:title="t('components.settings.connectedApps.connectedAppRegisterModal.title')"
		size="lg"
		:closable="!isSubmitting"
		:persistent="isSubmitting"
		@update:open="(v: boolean) => !v && emit('close')"
	>
		<!-- No bundled plugin to bind to. -->
		<div v-if="plugins.length === 0" class="py-6">
			<UiEmptyState
				icon="lucide:puzzle"
				:title="t('components.settings.connectedApps.connectedAppRegisterModal.noPluginsTitle')"
				:description="t('components.settings.connectedApps.connectedAppRegisterModal.noPluginsDescription')"
			/>
		</div>

		<!-- Step 1 — details -->
		<form v-else-if="step === 'details'" @submit.prevent="goToCapabilities">
			<h3 ref="detailsHeading" tabindex="-1" class="sr-only">{{ t('components.settings.connectedApps.connectedAppRegisterModal.detailsStepHeading') }}</h3>
			<div
				v-if="detailsError"
				role="alert"
				class="mb-4 p-3 rounded-lg bg-error-subtle border border-error/20 flex items-start gap-3"
			>
				<Icon name="lucide:alert-circle" class="w-5 h-5 text-error shrink-0 mt-0.5" />
				<p class="text-sm text-error">{{ detailsError }}</p>
			</div>

			<div v-if="plugins.length > 1" class="mb-5">
				<label for="connected-app-plugin" class="label">
					{{ t('components.settings.connectedApps.connectedAppRegisterModal.pluginLabel') }} <span class="text-error">*</span>
				</label>
				<select
					id="connected-app-plugin"
					v-model="pluginId"
					class="input"
					:disabled="isSubmitting"
				>
					<option value="" disabled>{{ t('components.settings.connectedApps.connectedAppRegisterModal.pluginPlaceholder') }}</option>
					<option v-for="plugin in plugins" :key="plugin.pluginId" :value="plugin.pluginId">
						{{ plugin.pluginId }}
					</option>
				</select>
			</div>

			<div class="mb-5">
				<label for="connected-app-name" class="label">
					{{ t('common.name') }} <span class="text-error">*</span>
				</label>
				<input
					id="connected-app-name"
					v-model="name"
					type="text"
					class="input"
					:placeholder="t('components.settings.connectedApps.connectedAppRegisterModal.namePlaceholder')"
					:disabled="isSubmitting"
				/>
				<p class="mt-1 text-xs text-text-tertiary">
					{{ t('components.settings.connectedApps.connectedAppRegisterModal.nameHint') }}
				</p>
			</div>

			<div>
				<label for="connected-app-endpoint" class="label">
					{{ t('components.settings.connectedApps.connectedAppRegisterModal.endpointLabel') }} <span class="text-error">*</span>
				</label>
				<input
					id="connected-app-endpoint"
					v-model="endpointUrl"
					type="url"
					inputmode="url"
					class="input"
					:placeholder="t('components.settings.connectedApps.connectedAppRegisterModal.endpointPlaceholder')"
					:disabled="isSubmitting"
				/>
				<p class="mt-1 text-xs text-text-tertiary">
					{{ t('components.settings.connectedApps.connectedAppRegisterModal.endpointHint') }}
				</p>
			</div>
		</form>

		<!-- Step 2 — capabilities + risk disclosure -->
		<form v-else @submit.prevent="submit">
			<div
				ref="riskRegion"
				tabindex="-1"
				class="mb-5 p-4 rounded-lg bg-warning/10 border border-warning/20 outline-none focus-visible:ring-2 focus-visible:ring-warning/50"
				role="note"
				:aria-label="t('components.settings.connectedApps.connectedAppRegisterModal.riskDisclosureLabel')"
			>
				<div class="flex items-start gap-3">
					<Icon name="lucide:shield-alert" class="w-5 h-5 text-warning shrink-0 mt-0.5" />
					<div class="text-sm text-warning/90 space-y-1">
						<p class="font-medium text-warning">{{ t('components.settings.connectedApps.connectedAppRegisterModal.riskTitle') }}</p>
						<p>
							{{ t('components.settings.connectedApps.connectedAppRegisterModal.riskBody') }}
						</p>
						<I18nT keypath="components.settings.connectedApps.connectedAppRegisterModal.riskLimits" tag="p" scope="global">
							<template #emphasis>
								<strong>{{ t('components.settings.connectedApps.connectedAppRegisterModal.riskLimitsEmphasis') }}</strong>
							</template>
						</I18nT>
					</div>
				</div>
			</div>

			<div
				v-if="errorMessage"
				role="alert"
				class="mb-4 p-3 rounded-lg bg-error-subtle border border-error/20 flex items-start gap-3"
			>
				<Icon name="lucide:alert-circle" class="w-5 h-5 text-error shrink-0 mt-0.5" />
				<p class="text-sm text-error">{{ errorMessage }}</p>
			</div>

			<fieldset :disabled="isSubmitting">
				<legend class="label">
					{{ t('components.settings.connectedApps.connectedAppRegisterModal.capabilitiesLegend') }} <span class="text-error">*</span>
				</legend>
				<p class="mb-2 text-xs text-text-tertiary">
					{{ t('components.settings.connectedApps.connectedAppRegisterModal.capabilitiesHint') }}
				</p>
				<div v-if="availableCapabilities.length === 0" class="text-sm text-text-tertiary py-2">
					{{ t('components.settings.connectedApps.connectedAppRegisterModal.noCapabilities') }}
				</div>
				<div v-else class="space-y-2">
					<label
						v-for="capability in availableCapabilities"
						:key="capability"
						class="flex items-start gap-3 p-3 rounded-lg border border-border cursor-pointer hover:bg-bg-surface"
						:class="{ 'opacity-60 cursor-not-allowed': isSubmitting }"
					>
						<input
							type="checkbox"
							class="mt-0.5 shrink-0"
							:value="capability"
							:checked="selectedCapabilities.includes(capability)"
							:disabled="isSubmitting"
							@change="toggleCapability(capability)"
						/>
						<span class="min-w-0">
							<span class="block text-sm font-medium text-text-primary">
								{{ connectedAppCapabilityLabel(capability) }}
							</span>
							<code class="block text-xs text-text-tertiary font-mono">{{ capability }}</code>
						</span>
					</label>
				</div>
			</fieldset>
		</form>

		<template #footer>
			<template v-if="plugins.length === 0">
				<UiButton variant="secondary" @click="emit('close')">{{ t('common.close') }}</UiButton>
			</template>
			<template v-else-if="step === 'details'">
				<UiButton variant="secondary" :disabled="isSubmitting" @click="emit('close')">
					{{ t('common.cancel') }}
				</UiButton>
				<UiButton variant="primary" @click="goToCapabilities">{{ t('common.continue') }}</UiButton>
			</template>
			<template v-else>
				<UiButton variant="secondary" :disabled="isSubmitting" @click="goBack">
					{{ t('common.back') }}
				</UiButton>
				<UiButton variant="primary" :loading="isSubmitting" :disabled="!canSubmit" @click="submit">
					{{ t('components.settings.connectedApps.connectedAppRegisterModal.submit') }}
				</UiButton>
			</template>
		</template>
	</UiModal>
</template>
