<script setup lang="ts">
import { api } from '@owlat/api';

type ChannelType = 'email' | 'sms' | 'whatsapp' | 'generic' | 'chat';

const props = defineProps<{
	channel: ChannelType;
	currentConfig: string | null;
	displayName: string;
}>();

const emit = defineEmits<{
	saved: [];
	cancelled: [];
}>();

const isSaving = ref(false);
// Bound as the inline target so config-validation failures show on the form.
const formError = ref<string | null>('');

const { run: updateChannelConfig } = useBackendOperation(api.unifiedMessages.updateChannelConfig, {
	label: 'Save channel configuration',
	inlineTarget: formError,
});

// Display name
const localDisplayName = ref(props.displayName);

// Parse existing config
function parseConfig(configStr: string | null): Record<string, string> {
	if (!configStr) return {};
	try {
		return JSON.parse(configStr);
	} catch {
		return {};
	}
}

const parsedConfig = parseConfig(props.currentConfig);

// Channel-specific field definitions
interface ConfigField {
	key: string;
	label: string;
	placeholder: string;
	type: 'text' | 'password' | 'url';
}

const channelFields: Record<ChannelType, ConfigField[]> = {
	email: [],
	sms: [
		{ key: 'accountSid', label: 'Account SID', placeholder: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', type: 'text' },
		{ key: 'authToken', label: 'Auth Token', placeholder: 'Enter your Twilio auth token', type: 'password' },
		{ key: 'phoneNumber', label: 'Phone Number', placeholder: '+1234567890', type: 'text' },
	],
	whatsapp: [
		{ key: 'businessAccountId', label: 'Business Account ID', placeholder: 'Enter your WhatsApp Business Account ID', type: 'text' },
		{ key: 'accessToken', label: 'Access Token', placeholder: 'Enter your access token', type: 'password' },
		{ key: 'phoneNumberId', label: 'Phone Number ID', placeholder: 'Enter your phone number ID', type: 'text' },
	],
	generic: [
		{ key: 'endpointUrl', label: 'Endpoint URL', placeholder: 'https://example.com/webhook', type: 'url' },
		{ key: 'secretKey', label: 'Secret Key', placeholder: 'Shared secret the sender must echo in x-webhook-secret', type: 'password' },
	],
	chat: [],
};

const fields = computed(() => channelFields[props.channel] ?? []);
const hasConfigFields = computed(() => fields.value.length > 0);

// Initialize field values from existing config
const fieldValues = reactive<Record<string, string>>({});
for (const field of channelFields[props.channel] ?? []) {
	fieldValues[field.key] = parsedConfig[field.key] ?? '';
}

// Channel info messages for the built-in channels (no per-channel credentials).
// Email/chat are not offered in the Add-channel menu; these only render for an
// existing email/chat config row. Email sending lives elsewhere — point there.
const channelInfoMessages: Record<ChannelType, string> = {
	email: 'Email is built in — there are no credentials to set here. Configure email sending under Sending Domains and your delivery provider in Technical settings.',
	chat: 'Chat is natively integrated and requires no additional configuration.',
	sms: '',
	whatsapp: '',
	generic: '',
};

// Password visibility toggles
const visibleFields = reactive<Record<string, boolean>>({});

function toggleFieldVisibility(key: string) {
	visibleFields[key] = !visibleFields[key];
}

// Save handler
async function handleSave() {
	isSaving.value = true;

	// Build config JSON from field values
	let configJson: string | undefined;
	if (hasConfigFields.value) {
		const configObj: Record<string, string> = {};
		for (const field of fields.value) {
			if (fieldValues[field.key]) {
				configObj[field.key] = fieldValues[field.key] ?? '';
			}
		}
		configJson = Object.keys(configObj).length > 0 ? JSON.stringify(configObj) : undefined;
	}

	const result = await updateChannelConfig({
		channel: props.channel,
		displayName: localDisplayName.value || undefined,
		...(configJson !== undefined ? { config: configJson } : {}),
	});
	isSaving.value = false;

	if (result === undefined) return;

	emit('saved');
}
</script>

<template>
	<div class="space-y-4">
		<!-- Display Name -->
		<div>
			<label for="localdisplayname" class="block text-sm font-medium text-text-primary mb-1.5">Display Name</label>
			<input id="localdisplayname"
				v-model="localDisplayName"
				type="text"
				class="input w-full"
				placeholder="Custom name for this channel"
			/>
			<p class="text-xs text-text-tertiary mt-1">
				Optional. Shown in the UI instead of the default channel name.
			</p>
		</div>

		<!-- Channel-specific fields -->
		<template v-if="hasConfigFields">
			<div v-for="field in fields" :key="field.key">
				<label class="block text-sm font-medium text-text-primary mb-1.5">{{ field.label }}</label>
				<div class="relative">
					<input
						v-model="fieldValues[field.key]"
						:type="field.type === 'password' && !visibleFields[field.key] ? 'password' : 'text'"
						class="input w-full"
						:class="field.type === 'password' ? 'pr-10' : ''"
						:placeholder="field.placeholder"
					/>
					<button
						v-if="field.type === 'password'"
						type="button"
						:aria-label="visibleFields[field.key] ? 'Hide value' : 'Show value'"
						class="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-text-tertiary hover:text-text-secondary transition-colors"
						@click="toggleFieldVisibility(field.key)"
					>
						<Icon
							:name="visibleFields[field.key] ? 'lucide:eye-off' : 'lucide:eye'"
							class="w-4 h-4"
						/>
					</button>
				</div>
			</div>
		</template>

		<!-- Info message for channels with no config -->
		<div
			v-else
			class="flex items-start gap-3 rounded-lg bg-brand-subtle/50 border border-brand/20 p-4"
		>
			<Icon name="lucide:info" class="w-5 h-5 text-brand shrink-0 mt-0.5" />
			<p class="text-sm text-text-secondary">
				{{ channelInfoMessages[channel] }}
			</p>
		</div>

		<!-- Error Message -->
		<div
			v-if="formError"
			class="flex items-start gap-3 rounded-lg bg-error-subtle border border-error/20 p-4"
		>
			<Icon name="lucide:alert-circle" class="w-5 h-5 text-error shrink-0 mt-0.5" />
			<p class="text-sm text-error">{{ formError }}</p>
		</div>

		<!-- Actions -->
		<div class="flex items-center justify-end gap-3 pt-2">
			<button
				class="btn btn-secondary"
				:disabled="isSaving"
				@click="emit('cancelled')"
			>
				Cancel
			</button>
			<button
				class="btn btn-primary gap-2"
				:disabled="isSaving"
				@click="handleSave"
			>
				<Icon
					v-if="isSaving"
					name="lucide:loader-2"
					class="w-4 h-4 animate-spin"
				/>
				{{ isSaving ? 'Saving...' : 'Save Configuration' }}
			</button>
		</div>
	</div>
</template>
