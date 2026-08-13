<script setup lang="ts">
import { api } from '@owlat/api';
// Derived from the backend contract, not restated here: adding a channel to
// `unifiedMessageChannelValidator` must break the exhaustive Records below
// rather than silently render a channel with no credential fields.
import type { ChannelKind } from '~/utils/channelKinds';

const props = defineProps<{
	channel: ChannelKind;
	/**
	 * Names of the credential fields already stored for this channel
	 * (`channelConfigs.configuredFields`). The values themselves are encrypted at
	 * rest and openable only in a Node action, so they are never read back into
	 * this form — the names are what lets it say "stored" instead of rendering an
	 * empty input that looks unset.
	 */
	storedFields: string[];
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

/** Does the backend already hold a value for this credential field? */
function isStored(key: string): boolean {
	return props.storedFields.includes(key);
}

// Channel-specific field definitions
interface ConfigField {
	key: string;
	label: string;
	placeholder: string;
	type: 'text' | 'password' | 'url';
	/**
	 * Optional clarifying line under the input, same treatment as the Display
	 * Name hint. Used to say what a stored value actually does — a credential
	 * the operator believes is in force but that nothing reads is the failure
	 * mode this exists to prevent.
	 */
	hint?: string;
}

const channelFields: Record<ChannelKind, ConfigField[]> = {
	email: [],
	sms: [
		{
			key: 'accountSid',
			label: 'Account SID',
			placeholder: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
			type: 'text',
		},
		{
			key: 'authToken',
			label: 'Auth Token',
			placeholder: 'Enter your Twilio auth token',
			type: 'password',
			hint: 'Used to send, and to verify the signature on inbound Twilio webhooks.',
		},
		{ key: 'phoneNumber', label: 'Phone Number', placeholder: '+1234567890', type: 'text' },
	],
	whatsapp: [
		{
			key: 'businessAccountId',
			label: 'Business Account ID',
			placeholder: 'Enter your WhatsApp Business Account ID',
			type: 'text',
			hint: 'Recorded for reference. Outbound sends are keyed on the Phone Number ID below.',
		},
		{
			key: 'accessToken',
			label: 'Access Token',
			placeholder: 'Enter your access token',
			type: 'password',
		},
		{
			key: 'phoneNumberId',
			label: 'Phone Number ID',
			placeholder: 'Enter your phone number ID',
			type: 'text',
		},
		{
			key: 'appSecret',
			label: 'App Secret',
			placeholder: 'Enter your Meta app secret',
			type: 'password',
			hint: 'Inbound only. Verifies the X-Hub-Signature-256 on messages Meta posts to /webhooks/whatsapp.',
		},
		{
			key: 'verifyToken',
			label: 'Verify Token',
			placeholder: 'Any string you also paste into Meta',
			type: 'password',
			hint: "Inbound only. Answers Meta's subscription challenge when you point it at /webhooks/whatsapp.",
		},
	],
	generic: [
		{
			key: 'endpointUrl',
			label: 'Endpoint URL',
			placeholder: 'https://example.com/webhook',
			type: 'url',
			hint: 'Outbound POSTs are unsigned — put any authentication in the URL itself (secret path or query token).',
		},
		{
			key: 'secretKey',
			label: 'Secret Key',
			placeholder: 'Shared secret for inbound requests',
			type: 'password',
			hint: 'Inbound only. Callers to /webhooks/channel must echo it in X-Webhook-Secret or Authorization: Bearer.',
		},
	],
	chat: [],
};

const fields = computed(() => channelFields[props.channel] ?? []);
const hasConfigFields = computed(() => fields.value.length > 0);

// Every input starts blank: stored values are encrypted at rest and are never
// sent back to the browser. A field left blank keeps whatever is stored (the
// backend merges the save over it), so blank means "unchanged", not "clear".
const fieldValues = reactive<Record<string, string>>({});
for (const field of channelFields[props.channel] ?? []) {
	fieldValues[field.key] = '';
}

/**
 * What an empty input should say. A stored credential says so rather than
 * showing the example value, which would read as an unset required field and
 * invite an operator to retype every credential on every edit.
 */
function inputPlaceholder(field: ConfigField): string {
	return isStored(field.key) ? '•••••••• stored — leave blank to keep' : field.placeholder;
}

// Channel info messages for the built-in channels (no per-channel credentials).
// Email/chat are not offered in the Add-channel menu; these only render for an
// existing email/chat config row. Email sending lives elsewhere — point there.
const channelInfoMessages: Record<ChannelKind, string> = {
	email:
		'Email is built in — there are no credentials to set here. Configure email sending under Sending Domains and your delivery provider in Technical settings.',
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
			<label for="localdisplayname" class="block text-sm font-medium text-text-primary mb-1.5"
				>Display Name</label
			>
			<input
				id="localdisplayname"
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
			<!-- Stored credentials are encrypted at rest and are never read back
			     into this form, so a blank input is not an empty credential — the
			     backend merges each save over what is stored. Say so, and mark the
			     fields that already hold a value, so a partial edit is a safe and
			     obvious thing to do. -->
			<p class="text-xs text-text-tertiary">
				Saved credentials are encrypted and not shown again. Leave a field blank to keep its stored
				value; type in one to replace just that credential.
			</p>
			<div v-for="field in fields" :key="field.key">
				<label class="flex items-center gap-2 text-sm font-medium text-text-primary mb-1.5">
					{{ field.label }}
					<span v-if="isStored(field.key)" class="text-xs font-normal text-text-tertiary"
						>stored</span
					>
				</label>
				<div class="relative">
					<input
						v-model="fieldValues[field.key]"
						:type="field.type === 'password' && !visibleFields[field.key] ? 'password' : 'text'"
						class="input w-full"
						:class="field.type === 'password' ? 'pr-10' : ''"
						:placeholder="inputPlaceholder(field)"
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
				<p v-if="field.hint" class="text-xs text-text-tertiary mt-1">
					{{ field.hint }}
				</p>
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
			<UiButton variant="secondary" :disabled="isSaving" @click="emit('cancelled')">
				Cancel
			</UiButton>
			<UiButton class="gap-2" :disabled="isSaving" @click="handleSave">
				<Icon v-if="isSaving" name="lucide:loader-2" class="w-4 h-4 animate-spin" />
				{{ isSaving ? 'Saving...' : 'Save Configuration' }}
			</UiButton>
		</div>
	</div>
</template>
