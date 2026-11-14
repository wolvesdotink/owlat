<script setup lang="ts">
/**
 * A sender address built from a typed local part and a sending domain chosen
 * from the instance's domains, plus a display name. Verified domains come
 * first; an unverified one stays choosable so the verdict below can say why it
 * cannot be saved and link to where it gets fixed. The verdict is announced as
 * it changes, and every state carries an icon and words, not colour alone.
 */
import {
	formatFromAddress,
	senderDraftAddress,
	senderDraftVerdict,
	type SendingDomainOption,
	type SenderDraft,
} from '~/utils/transactionalSender';
import { CircleCheckIcon, CircleInfoIcon, TriangleWarningIcon } from '@coolicons/vue';
import { useLocalized } from '~/composables/useLocalized';

const props = defineProps<{
	domains: readonly SendingDomainOption[];
	disabled?: boolean;
}>();

const draft = defineModel<SenderDraft>({ required: true });

const { t } = useI18n();
const localized = useLocalized();
const P = 'components.transactional.senderAddressField';

const ids = {
	local: useId(),
	domain: useId(),
	name: useId(),
	verdict: useId(),
};

const verifiedDomains = computed(() => props.domains.filter((d) => d.isVerified));
const unverifiedDomains = computed(() => props.domains.filter((d) => !d.isVerified));
// A stored address whose domain is no longer registered keeps its domain in
// the list, so the field shows what is saved and the verdict says why it fails.
const strayDomain = computed(() => {
	const domain = draft.value.domain.trim().toLowerCase();
	return domain && !props.domains.some((d) => d.domain === domain) ? domain : null;
});

const verdict = computed(() => senderDraftVerdict(draft.value, props.domains));
const preview = computed(() => {
	const address = senderDraftAddress(draft.value);
	return address ? formatFromAddress(draft.value.name, address) : '';
});

function update(patch: Partial<SenderDraft>) {
	draft.value = { ...draft.value, ...patch };
}

defineExpose({ canSave: computed(() => verdict.value.canSave) });
</script>

<template>
	<div class="space-y-4">
		<div>
			<label :for="ids.local" class="label">{{ t(`${P}.addressLabel`) }}</label>
			<!-- Local part and domain on one line; the domain wraps under it on a
			     phone so neither is cut off. -->
			<div class="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-2">
				<input
					:id="ids.local"
					:value="draft.localPart"
					type="text"
					inputmode="email"
					autocomplete="off"
					spellcheck="false"
					class="input flex-1 min-w-[8rem]"
					:placeholder="t(`${P}.localPartPlaceholder`)"
					:disabled="disabled"
					:aria-describedby="ids.verdict"
					:aria-invalid="verdict.tone === 'warning' ? 'true' : undefined"
					data-testid="sender-local-part"
					@input="update({ localPart: ($event.target as HTMLInputElement).value })"
				/>
				<span class="text-sm text-text-tertiary" aria-hidden="true">@</span>
				<select
					:id="ids.domain"
					:value="draft.domain"
					class="input flex-1 min-w-[11rem]"
					:aria-label="t(`${P}.domainLabel`)"
					:aria-describedby="ids.verdict"
					:disabled="disabled || domains.length === 0"
					data-testid="sender-domain"
					@change="update({ domain: ($event.target as HTMLSelectElement).value })"
				>
					<option v-if="!draft.domain" value="" disabled>
						{{ t(`${P}.domainPlaceholder`) }}
					</option>
					<optgroup v-if="verifiedDomains.length" :label="t(`${P}.verifiedGroup`)">
						<option v-for="d in verifiedDomains" :key="d.domain" :value="d.domain">
							{{ d.domain }}
						</option>
					</optgroup>
					<optgroup v-if="unverifiedDomains.length" :label="t(`${P}.unverifiedGroup`)">
						<option v-for="d in unverifiedDomains" :key="d.domain" :value="d.domain">
							{{ d.domain }}
						</option>
					</optgroup>
					<option v-if="strayDomain" :value="strayDomain">{{ strayDomain }}</option>
				</select>
			</div>
			<!-- The verdict for the address as it stands, announced as it changes. -->
			<p
				:id="ids.verdict"
				role="status"
				:class="[
					'mt-1.5 text-xs flex items-start gap-1.5',
					verdict.tone === 'warning'
						? 'text-warning'
						: verdict.tone === 'success'
							? 'text-success'
							: 'text-text-tertiary',
				]"
				data-testid="sender-verdict"
			>
				<component
					:is="
						verdict.tone === 'success'
							? CircleCheckIcon
							: verdict.tone === 'warning'
								? TriangleWarningIcon
								: CircleInfoIcon
					"
					class="w-3.5 h-3.5 shrink-0 mt-px"
					aria-hidden="true"
				/>
				<span>
					{{ localized(verdict.message) }}
					<NuxtLink
						v-if="verdict.showDomainsLink"
						to="/dashboard/admin/delivery/domains"
						class="underline whitespace-nowrap"
						data-testid="sender-domains-link"
					>
						{{ t(`${P}.domainsLink`) }}
					</NuxtLink>
				</span>
			</p>
		</div>

		<UiInput
			:id="ids.name"
			:model-value="draft.name"
			:label="t(`${P}.nameLabel`)"
			:placeholder="t(`${P}.namePlaceholder`)"
			:help-text="t(`${P}.nameHelp`)"
			:disabled="disabled"
			@update:model-value="update({ name: String($event ?? '') })"
		/>

		<p v-if="preview" class="text-xs text-text-tertiary" data-testid="sender-preview">
			{{ t(`${P}.preview`) }}
			<span class="font-mono text-text-secondary break-words">{{ preview }}</span>
		</p>
	</div>
</template>
