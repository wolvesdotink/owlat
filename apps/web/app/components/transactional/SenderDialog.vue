<script setup lang="ts">
/**
 * The instance's transactional sender: keep the default sender, or give
 * password resets, receipts and other API sends an address of their own. When
 * the stream-subdomain layout has a verified transactional subdomain, it is
 * offered first with the one reason it matters. Saving is refused (here and on
 * the server) unless the address is on a verified sending domain.
 */
import { api } from '@owlat/api';
import {
	formatFromAddress,
	initialSenderDraft,
	isSenderDraftChanged,
	senderDraftAddress,
	senderDraftVerdict,
	splitSenderAddress,
	type SenderDraft,
} from '~/utils/transactionalSender';
import { ReloadIcon } from '@coolicons/vue';

const open = defineModel<boolean>('open', { required: true });

const { t } = useI18n();
const { showToast } = useToast();
const P = 'components.transactional.senderDialog';

const { data, isLoading, error, refetch } = useOrganizationQuery(api.transactional.sender.get);

const saveError = ref<string | null>(null);
const { run: saveSender, isLoading: isSaving } = useBackendOperation(
	api.transactional.sender.setInstanceSender,
	{ label: () => t(`${P}.operation`), inlineTarget: saveError }
);

type Mode = 'default' | 'own';
const mode = ref<Mode>('default');
const draft = ref<SenderDraft>({ localPart: '', domain: '', name: '' });

const current = computed(() => data.value?.transactional ?? null);
const defaultSender = computed(() => data.value?.defaultSender ?? null);
const domains = computed(() => data.value?.sendingDomains ?? []);
const suggestedDomain = computed(() => data.value?.suggestedDomain ?? null);

function freshDraft(): SenderDraft {
	return initialSenderDraft({
		current: current.value,
		suggestedDomain: suggestedDomain.value,
		domains: domains.value,
		fallback: defaultSender.value,
	});
}

// Every open starts from what is saved.
let initialized = false;
function reset() {
	mode.value = current.value ? 'own' : 'default';
	draft.value = freshDraft();
	saveError.value = null;
}
watch(
	[open, data],
	([isOpen, loaded]) => {
		if (!isOpen) {
			initialized = false;
			return;
		}
		if (loaded && !initialized) {
			initialized = true;
			reset();
		}
	},
	{ immediate: true }
);

// Offer the transactional subdomain while it is not already the choice.
const showSuggestion = computed(
	() =>
		suggestedDomain.value !== null &&
		splitSenderAddress(current.value?.email).domain !== suggestedDomain.value &&
		!(mode.value === 'own' && draft.value.domain === suggestedDomain.value)
);
// No layout to suggest from: say why a subdomain helps and where to plan one.
const showLayoutTip = computed(() => suggestedDomain.value === null && domains.value.length > 0);
const exampleRoot = computed(
	() =>
		splitSenderAddress(defaultSender.value?.address).domain ||
		domains.value.find((d) => d.isVerified)?.domain ||
		'example.com'
);

function useSuggestion() {
	if (!suggestedDomain.value) return;
	mode.value = 'own';
	draft.value = { ...draft.value, domain: suggestedDomain.value };
	if (!draft.value.localPart) {
		draft.value.localPart = splitSenderAddress(defaultSender.value?.address).localPart;
	}
}

const verdict = computed(() => senderDraftVerdict(draft.value, domains.value));
const isChanged = computed(() =>
	mode.value === 'default'
		? current.value !== null
		: isSenderDraftChanged(draft.value, current.value)
);
const canSave = computed(
	() => isChanged.value && !isSaving.value && (mode.value === 'default' || verdict.value.canSave)
);

async function save() {
	if (!canSave.value) return;
	saveError.value = null;
	const result = await saveSender({
		sender:
			mode.value === 'default'
				? null
				: {
						email: senderDraftAddress(draft.value),
						...(draft.value.name.trim() ? { name: draft.value.name.trim() } : {}),
					},
	});
	if (!result.ok) return;
	showToast(
		mode.value === 'default'
			? t(`${P}.savedDefault`)
			: t(`${P}.saved`, { address: senderDraftAddress(draft.value) })
	);
	open.value = false;
}
</script>

<template>
	<UiModal
		v-model:open="open"
		:title="t(`${P}.title`)"
		size="lg"
		:persistent="isSaving"
		data-testid="transactional-sender-dialog"
	>
		<p class="text-sm text-text-secondary mb-5">{{ t(`${P}.intro`) }}</p>

		<div v-if="isLoading && !data" class="space-y-3" role="status" :aria-label="t(`${P}.loading`)">
			<UiSkeleton class="h-16 w-full" />
			<UiSkeleton class="h-16 w-full" />
		</div>

		<UiErrorAlert
			v-else-if="error"
			:message="t(`${P}.loadError`)"
			:action-label="t('common.tryAgain')"
			:action-icon="ReloadIcon"
			@action="refetch"
		/>

		<form v-else-if="data" class="space-y-5" @submit.prevent="save">
			<UiErrorAlert v-if="saveError" :message="saveError" />

			<!-- The stream-subdomain layout's transactional host, offered with the one
			     reason it matters. Choosing it fills the address below; Save applies. -->
			<div
				v-if="showSuggestion"
				class="rounded-lg border border-border-subtle bg-bg-surface p-4 flex flex-wrap items-start gap-3"
				data-testid="transactional-sender-suggestion"
			>
				<div class="flex-1 min-w-[14rem]">
					<p class="text-sm font-medium text-text-primary">
						{{ t(`${P}.suggestion.title`, { domain: suggestedDomain }) }}
					</p>
					<p class="text-xs text-text-secondary mt-0.5">{{ t(`${P}.suggestion.why`) }}</p>
				</div>
				<UiButton size="sm" variant="secondary" :disabled="isSaving" @click="useSuggestion">
					{{ t(`${P}.suggestion.use`, { domain: suggestedDomain }) }}
				</UiButton>
			</div>

			<fieldset class="space-y-2">
				<legend class="sr-only">{{ t(`${P}.modeLegend`) }}</legend>
				<UiSelectableListItem
					v-model="mode"
					value="default"
					name="transactional-sender-mode"
					:label="t(`${P}.useDefault`)"
					:description="
						defaultSender
							? t(`${P}.useDefaultDescription`, {
									from: formatFromAddress(defaultSender.name, defaultSender.address),
								})
							: t(`${P}.useDefaultMissing`)
					"
					:disabled="isSaving"
				/>
				<UiSelectableListItem
					v-model="mode"
					value="own"
					name="transactional-sender-mode"
					:label="t(`${P}.useOwn`)"
					:description="t(`${P}.useOwnDescription`)"
					:disabled="isSaving"
				/>
			</fieldset>

			<TransactionalSenderAddressField
				v-if="mode === 'own'"
				v-model="draft"
				:domains="domains"
				:disabled="isSaving"
			/>

			<p v-if="showLayoutTip" class="text-xs text-text-tertiary">
				{{ t(`${P}.layoutTip`, { host: `mail.${exampleRoot}` }) }}
				<NuxtLink to="/dashboard/admin/delivery/domains" class="underline whitespace-nowrap">
					{{ t(`${P}.layoutLink`) }}
				</NuxtLink>
			</p>
		</form>

		<template #footer>
			<UiModalFooter
				:confirm-text="isSaving ? t(`${P}.saving`) : t(`${P}.save`)"
				:is-loading="isSaving"
				:is-disabled="!canSave"
				@cancel="open = false"
				@confirm="save"
			/>
		</template>
	</UiModal>
</template>
