<script setup lang="ts">
/**
 * "Who receives mail for this domain?" — the send-only choice, shared by the
 * Add-Domain form and the per-domain mode switch so the two can never offer
 * different options or different words for the same thing.
 *
 * WHY THE QUESTION IS ASKED AT ALL: the domain setup panel's default guidance
 * hands the operator an APEX MX record pointing at this deployment. For a domain
 * whose mail lives on Google Workspace or Microsoft 365 that record takes EVERY
 * incoming message away from their provider — the single most destructive thing
 * this product can talk somebody into. It is also not recoverable by re-reading
 * the page: by the time mail stops arriving, the MX has propagated.
 *
 * So the question is asked BEFORE any record is generated, and the answer is
 * stored on the domain row, because what Owlat generates depends on it: the apex
 * SPF is merged with the provider's own include (publishing ours verbatim breaks
 * SPF for everything they still send from Gmail), and TLS-RPT is dropped (it
 * solicits reports about INBOUND delivery, which for this domain terminates at
 * the provider, not here).
 *
 * Controlled component — it owns no state. Both call sites drive it from their
 * own draft, which is what lets the switch stage a change behind a confirmation
 * while the add-form applies it straight into the create payload.
 */
import { useId } from 'vue';
import type { ExternalReceivingProvider } from '@owlat/shared/externalReceiving';
import type { ReceivingMode } from '~/composables/useAddDomainForm';
import {
	EXTERNAL_RECEIVING_OPTION_KEYS,
	EXTERNAL_RECEIVING_PROVIDER_IDS,
} from '~/utils/externalReceivingLabels';

defineProps<{
	/** Which side of the choice is currently selected. */
	mode: ReceivingMode;
	/** The provider pick, only meaningful while `mode` is `'external'`. */
	provider: ExternalReceivingProvider;
	/** Freeze the whole group while a submit / save is in flight. */
	disabled?: boolean;
}>();

const emit = defineEmits<{
	'update:mode': [mode: ReceivingMode];
	'update:provider': [provider: ExternalReceivingProvider];
}>();

const { t } = useI18n();

// Radio groups are keyed by `name`, and this component is mounted more than once
// on the domains page (the add modal plus one switch per expanded row). A
// hardcoded name would silently join every instance into ONE group, so choosing
// "external" in the modal would clear the row below it.
const uid = useId();
const groupName = `${uid}-receiving-mode`;
const providerSelectId = `${uid}-receiving-provider`;

const providerIds = EXTERNAL_RECEIVING_PROVIDER_IDS;
const optionLabel = (id: ExternalReceivingProvider) => t(EXTERNAL_RECEIVING_OPTION_KEYS[id]);
</script>

<template>
	<fieldset :disabled="disabled" data-testid="receiving-mode-choice">
		<legend class="label">
			{{ t('components.domains.receivingModeChoice.legend') }}
		</legend>

		<div class="space-y-2">
			<!-- Today's behaviour, and still the default: Owlat becomes the mail
			     server for this domain. -->
			<label
				class="flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 transition-colors"
				:class="
					mode === 'owlat'
						? 'border-brand bg-brand/5'
						: 'border-border-subtle hover:bg-bg-surface-hover'
				"
			>
				<input
					type="radio"
					:name="groupName"
					value="owlat"
					class="mt-0.5"
					:checked="mode === 'owlat'"
					data-testid="receiving-mode-owlat"
					@change="emit('update:mode', 'owlat')"
				/>
				<span class="min-w-0">
					<span class="block text-sm font-medium text-text-primary">
						{{ t('components.domains.receivingModeChoice.owlat.label') }}
					</span>
					<span class="mt-0.5 block text-xs text-text-secondary">
						{{ t('components.domains.receivingModeChoice.owlat.hint') }}
					</span>
				</span>
			</label>

			<!-- Send-only: their provider keeps the MX and every incoming message. -->
			<label
				class="flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 transition-colors"
				:class="
					mode === 'external'
						? 'border-brand bg-brand/5'
						: 'border-border-subtle hover:bg-bg-surface-hover'
				"
			>
				<input
					type="radio"
					:name="groupName"
					value="external"
					class="mt-0.5"
					:checked="mode === 'external'"
					data-testid="receiving-mode-external"
					@change="emit('update:mode', 'external')"
				/>
				<span class="min-w-0">
					<span class="block text-sm font-medium text-text-primary">
						{{ t('components.domains.receivingModeChoice.external.label') }}
					</span>
					<span class="mt-0.5 block text-xs text-text-secondary">
						{{ t('components.domains.receivingModeChoice.external.hint') }}
					</span>
				</span>
			</label>
		</div>

		<!-- Which provider, and the promise that follows from it. The reassurance
		     is stated HERE, at the moment of choosing, rather than only in the
		     panel afterwards: the fear this answers ("will this break my email?")
		     is what makes people abandon the form. -->
		<div v-if="mode === 'external'" class="mt-3" data-testid="receiving-provider-picker">
			<label :for="providerSelectId" class="label">
				{{ t('components.domains.receivingModeChoice.providerLabel') }}
			</label>
			<select
				:id="providerSelectId"
				class="input"
				:value="provider"
				data-testid="receiving-provider-select"
				@change="
					emit(
						'update:provider',
						($event.target as HTMLSelectElement).value as ExternalReceivingProvider
					)
				"
			>
				<option v-for="id in providerIds" :key="id" :value="id">{{ optionLabel(id) }}</option>
			</select>
			<p class="mt-2 flex items-start gap-2 text-xs text-text-secondary">
				<Icon name="lucide:shield-check" class="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
				<span>{{ t('components.domains.receivingModeChoice.reassurance') }}</span>
			</p>
		</div>
	</fieldset>
</template>
