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
		detailsError.value = 'Choose the plugin this app connects to.';
		return;
	}
	if (!name.value.trim()) {
		detailsError.value = 'Give the connected app a name.';
		return;
	}
	if (!isValidHttpsUrl(endpointUrl.value.trim())) {
		detailsError.value =
			'Enter a valid HTTPS endpoint URL with no embedded credentials (e.g. https://hooks.example.com/owlat).';
		return;
	}
	step.value = 'capabilities';
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
		title="Connect an app"
		size="lg"
		:closable="!isSubmitting"
		:persistent="isSubmitting"
		@update:open="(v: boolean) => !v && emit('close')"
	>
		<!-- No bundled plugin to bind to. -->
		<div v-if="plugins.length === 0" class="py-6">
			<UiEmptyState
				icon="lucide:puzzle"
				title="No plugins to connect"
				description="Connected apps bind to a bundled plugin. Add a plugin to this deployment's build before connecting an external app."
			/>
		</div>

		<!-- Step 1 — details -->
		<form v-else-if="step === 'details'" @submit.prevent="goToCapabilities">
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
					Plugin <span class="text-error">*</span>
				</label>
				<select
					id="connected-app-plugin"
					v-model="pluginId"
					class="input"
					:disabled="isSubmitting"
				>
					<option value="" disabled>Select a plugin…</option>
					<option v-for="plugin in plugins" :key="plugin.pluginId" :value="plugin.pluginId">
						{{ plugin.pluginId }}
					</option>
				</select>
			</div>

			<div class="mb-5">
				<label for="connected-app-name" class="label">
					Name <span class="text-error">*</span>
				</label>
				<input
					id="connected-app-name"
					v-model="name"
					type="text"
					class="input"
					placeholder="e.g. Slack approvals"
					:disabled="isSubmitting"
				/>
				<p class="mt-1 text-xs text-text-tertiary">
					A label to recognize this connection later.
				</p>
			</div>

			<div>
				<label for="connected-app-endpoint" class="label">
					Hook endpoint <span class="text-error">*</span>
				</label>
				<input
					id="connected-app-endpoint"
					v-model="endpointUrl"
					type="url"
					inputmode="url"
					class="input"
					placeholder="https://hooks.example.com/owlat"
					:disabled="isSubmitting"
				/>
				<p class="mt-1 text-xs text-text-tertiary">
					Owlat signs and delivers hooks to this HTTPS URL. It must be publicly reachable — internal
					and private addresses are rejected.
				</p>
			</div>
		</form>

		<!-- Step 2 — capabilities + risk disclosure -->
		<form v-else @submit.prevent="submit">
			<div
				class="mb-5 p-4 rounded-lg bg-warning/10 border border-warning/20"
				role="note"
				aria-label="Connected app risk disclosure"
			>
				<div class="flex items-start gap-3">
					<Icon name="lucide:shield-alert" class="w-5 h-5 text-warning shrink-0 mt-0.5" />
					<div class="text-sm text-warning/90 space-y-1">
						<p class="font-medium text-warning">You're granting an external app access</p>
						<p>
							This connects an outside service to your workspace. It will hold a shared secret and
							can call Owlat with the capabilities you grant below.
						</p>
						<p>
							A connected app can only ever <strong>add work or caution</strong> — it can never
							approve, unblock, or send on your behalf, and it cannot remove Owlat's safety checks.
						</p>
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
					Capabilities to grant <span class="text-error">*</span>
				</legend>
				<p class="mb-2 text-xs text-text-tertiary">
					Grant only what this app needs. Each is a capability the plugin declared; you can grant a
					subset, never more.
				</p>
				<div v-if="availableCapabilities.length === 0" class="text-sm text-text-tertiary py-2">
					This plugin declares no capabilities to grant.
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
				<UiButton variant="secondary" @click="emit('close')">Close</UiButton>
			</template>
			<template v-else-if="step === 'details'">
				<UiButton variant="secondary" :disabled="isSubmitting" @click="emit('close')">
					Cancel
				</UiButton>
				<UiButton variant="primary" @click="goToCapabilities">Continue</UiButton>
			</template>
			<template v-else>
				<UiButton variant="secondary" :disabled="isSubmitting" @click="step = 'details'">
					Back
				</UiButton>
				<UiButton variant="primary" :loading="isSubmitting" :disabled="!canSubmit" @click="submit">
					Register app
				</UiButton>
			</template>
		</template>
	</UiModal>
</template>
