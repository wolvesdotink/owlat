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

const { t } = useI18n();

const isSaving = ref(false);
// Bound as the inline target so config-validation failures show on the form.
const formError = ref<string | null>('');

const { run: updateChannelConfig } = useBackendOperation(api.unifiedMessages.updateChannelConfig, {
	label: () => t('components.channels.channelConfigForm.operations.saveConfiguration'),
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
	/** Message key for the field label. */
	label: string;
	/** Message key for the empty-input placeholder. */
	placeholder: string;
	type: 'text' | 'password' | 'url';
	/**
	 * Message key for an optional clarifying line under the input, same treatment
	 * as the Display Name hint. Used to say what a stored value actually does — a
	 * credential the operator believes is in force but that nothing reads is the
	 * failure mode this exists to prevent.
	 */
	hint?: string;
}

// The definitions are built once, so they carry message KEYS and are translated
// where they are rendered.
const F = 'components.channels.channelConfigForm.fields';

const channelFields: Record<ChannelKind, ConfigField[]> = {
	email: [],
	sms: [
		{
			key: 'accountSid',
			label: `${F}.accountSid.label`,
			placeholder: `${F}.accountSid.placeholder`,
			type: 'text',
		},
		{
			key: 'authToken',
			label: `${F}.authToken.label`,
			placeholder: `${F}.authToken.placeholder`,
			type: 'password',
			hint: `${F}.authToken.hint`,
		},
		{
			key: 'phoneNumber',
			label: `${F}.phoneNumber.label`,
			placeholder: `${F}.phoneNumber.placeholder`,
			type: 'text',
		},
	],
	whatsapp: [
		{
			key: 'businessAccountId',
			label: `${F}.businessAccountId.label`,
			placeholder: `${F}.businessAccountId.placeholder`,
			type: 'text',
			hint: `${F}.businessAccountId.hint`,
		},
		{
			key: 'accessToken',
			label: `${F}.accessToken.label`,
			placeholder: `${F}.accessToken.placeholder`,
			type: 'password',
		},
		{
			key: 'phoneNumberId',
			label: `${F}.phoneNumberId.label`,
			placeholder: `${F}.phoneNumberId.placeholder`,
			type: 'text',
		},
		{
			key: 'appSecret',
			label: `${F}.appSecret.label`,
			placeholder: `${F}.appSecret.placeholder`,
			type: 'password',
			hint: `${F}.appSecret.hint`,
		},
		{
			key: 'verifyToken',
			label: `${F}.verifyToken.label`,
			placeholder: `${F}.verifyToken.placeholder`,
			type: 'password',
			hint: `${F}.verifyToken.hint`,
		},
	],
	generic: [
		{
			key: 'endpointUrl',
			label: `${F}.endpointUrl.label`,
			placeholder: `${F}.endpointUrl.placeholder`,
			type: 'url',
			hint: `${F}.endpointUrl.hint`,
		},
		{
			key: 'secretKey',
			label: `${F}.secretKey.label`,
			placeholder: `${F}.secretKey.placeholder`,
			type: 'password',
			hint: `${F}.secretKey.hint`,
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
	return isStored(field.key)
		? t('components.channels.channelConfigForm.storedPlaceholder')
		: t(field.placeholder);
}

// Channel info messages for the built-in channels (no per-channel credentials).
// Email/chat are not offered in the Add-channel menu; these only render for an
// existing email/chat config row. Email sending lives elsewhere — point there.
// Message keys, translated where the info box renders them.
const channelInfoMessages: Record<ChannelKind, string> = {
	email: 'components.channels.channelConfigForm.info.email',
	chat: 'components.channels.channelConfigForm.info.chat',
	sms: '',
	whatsapp: '',
	generic: '',
};

const channelInfoMessage = computed(() => {
	const key = channelInfoMessages[props.channel];
	return key ? t(key) : '';
});

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

	if (!result.ok) return;

	emit('saved');
}
</script>

<template>
	<div class="space-y-4">
		<!-- Display Name -->
		<div>
			<label for="localdisplayname" class="block text-sm font-medium text-text-primary mb-1.5">{{
				t('components.channels.channelConfigForm.displayNameLabel')
			}}</label>
			<input
				id="localdisplayname"
				v-model="localDisplayName"
				type="text"
				class="input w-full"
				:placeholder="t('components.channels.channelConfigForm.displayNamePlaceholder')"
			/>
			<p class="text-xs text-text-tertiary mt-1">
				{{ t('components.channels.channelConfigForm.displayNameHint') }}
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
				{{ t('components.channels.channelConfigForm.credentialsNotice') }}
			</p>
			<div v-for="field in fields" :key="field.key">
				<label class="flex items-center gap-2 text-sm font-medium text-text-primary mb-1.5">
					{{ t(field.label) }}
					<span v-if="isStored(field.key)" class="text-xs font-normal text-text-tertiary">{{
						t('components.channels.channelConfigForm.stored')
					}}</span>
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
						:aria-label="
							visibleFields[field.key]
								? t('components.channels.channelConfigForm.hideValue')
								: t('components.channels.channelConfigForm.showValue')
						"
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
					{{ t(field.hint) }}
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
				{{ channelInfoMessage }}
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
				{{ t('common.cancel') }}
			</UiButton>
			<UiButton class="gap-2" :disabled="isSaving" @click="handleSave">
				<Icon v-if="isSaving" name="lucide:loader-2" class="w-4 h-4 animate-spin" />
				{{ isSaving ? t('common.saving') : t('components.channels.channelConfigForm.save') }}
			</UiButton>
		</div>
	</div>
</template>
