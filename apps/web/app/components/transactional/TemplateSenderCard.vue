<script setup lang="ts">
/**
 * A transactional email's sender, in the editor beside its other send
 * settings. Until overridden it says which sender it inherits, so the default
 * is visible; overriding is one deliberate action, and "Use the transactional
 * sender" is the way back. The sender saves on its own, outside the editor's
 * Save, so a published email is not unpublished to change it.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import {
	formatFromAddress,
	initialSenderDraft,
	isSenderDraftChanged,
	senderDraftAddress,
	senderDraftVerdict,
	type SenderDraft,
} from '~/utils/transactionalSender';
import { CircleCheckIcon, ReloadIcon, TriangleWarningIcon } from '@coolicons/vue';

const props = defineProps<{ emailId: Id<'transactionalEmails'> }>();

const { t } = useI18n();
const { showToast } = useToast();
const P = 'components.transactional.templateSenderCard';
const headingId = useId();

const { data, isLoading, error, refetch } = useOrganizationQuery(
	api.transactional.sender.get,
	() => ({ templateId: props.emailId })
);

const saveError = ref<string | null>(null);
const { run: saveSender, isLoading: isSaving } = useBackendOperation(
	api.transactional.sender.setTemplateSender,
	{ label: () => t(`${P}.operation`), inlineTarget: saveError }
);

const own = computed(() => data.value?.template ?? null);
const inherited = computed(() => data.value?.inherited ?? null);
const resolved = computed(() => data.value?.resolved ?? null);
const canManage = computed(() => data.value?.canManageTemplate === true);

const isEditing = ref(false);
const draft = ref<SenderDraft>({ localPart: '', domain: '', name: '' });
const verdict = computed(() => senderDraftVerdict(draft.value, data.value?.sendingDomains ?? []));
const canSave = computed(
	() => verdict.value.canSave && isSenderDraftChanged(draft.value, own.value) && !isSaving.value
);

function startEditing() {
	draft.value = initialSenderDraft({
		current: own.value,
		suggestedDomain: data.value?.suggestedDomain ?? null,
		domains: data.value?.sendingDomains ?? [],
		fallback: inherited.value,
	});
	saveError.value = null;
	isEditing.value = true;
}

async function save() {
	if (!canSave.value) return;
	const result = await saveSender({
		id: props.emailId,
		sender: {
			email: senderDraftAddress(draft.value),
			...(draft.value.name.trim() ? { name: draft.value.name.trim() } : {}),
		},
	});
	if (!result.ok) return;
	isEditing.value = false;
	showToast(t(`${P}.saved`, { address: senderDraftAddress(draft.value) }));
}

async function useInherited() {
	saveError.value = null;
	const result = await saveSender({ id: props.emailId, sender: null });
	if (result.ok) showToast(t(`${P}.restored`));
}

const inheritedFrom = computed(() =>
	inherited.value ? formatFromAddress(inherited.value.name, inherited.value.address) : ''
);
const ownLine = computed(() =>
	own.value ? formatFromAddress(own.value.name ?? resolved.value?.name ?? '', own.value.email) : ''
);
</script>

<template>
	<section
		class="rounded-lg shadow-surface-1 bg-bg-elevated px-10 py-5"
		:aria-labelledby="headingId"
		data-testid="template-sender-card"
	>
		<!-- Title and actions on one row; the sentence below gets the full width,
		     so an address never breaks mid-word beside the buttons. -->
		<div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
			<h2 :id="headingId" class="text-base font-medium text-text-primary">
				{{ t(`${P}.title`) }}
			</h2>
			<div v-if="data && canManage && !isEditing" class="flex flex-wrap items-center gap-2">
				<UiButton
					v-if="own"
					size="sm"
					variant="ghost"
					:loading="isSaving"
					data-testid="template-sender-restore"
					@click="useInherited"
				>
					{{
						inherited?.source === 'transactional'
							? t(`${P}.useTransactional`)
							: t(`${P}.useDefault`)
					}}
				</UiButton>
				<UiButton
					size="sm"
					variant="secondary"
					:disabled="isSaving"
					data-testid="template-sender-edit"
					@click="startEditing"
				>
					{{ own ? t(`${P}.change`) : t(`${P}.override`) }}
				</UiButton>
			</div>
		</div>

		<p v-if="isLoading && !data" class="text-sm text-text-tertiary mt-1">
			{{ t(`${P}.loading`) }}
		</p>
		<template v-else-if="data && !isEditing">
			<!-- Overridden: this email's own sender and whether it can send. -->
			<template v-if="own">
				<p class="text-sm text-text-secondary mt-1" data-testid="template-sender-own">
					{{ t(`${P}.sendsFrom`) }}
					<span class="font-medium text-text-primary break-words">{{ ownLine }}</span>
				</p>
				<p
					:class="[
						'text-xs mt-1 flex items-center gap-1.5',
						resolved?.isDomainVerified ? 'text-success' : 'text-warning',
					]"
				>
					<component
						:is="resolved?.isDomainVerified ? CircleCheckIcon : TriangleWarningIcon"
						class="w-3.5 h-3.5 shrink-0"
						aria-hidden="true"
					/>
					{{ resolved?.isDomainVerified ? t(`${P}.verified`) : t(`${P}.unverified`) }}
				</p>
			</template>
			<!-- Inherited: which sender it uses, so the default is visible. -->
			<I18nT
				v-else-if="inherited"
				:keypath="
					inherited.source === 'transactional' ? `${P}.usesTransactional` : `${P}.usesDefault`
				"
				tag="p"
				scope="global"
				class="text-sm text-text-tertiary mt-1"
				data-testid="template-sender-inherited"
			>
				<template #from>
					<span class="font-medium text-text-primary break-words">{{ inheritedFrom }}</span>
				</template>
			</I18nT>
			<p v-else class="text-sm text-warning mt-1" data-testid="template-sender-inherited">
				{{ t(`${P}.noSender`) }}
			</p>
		</template>

		<UiErrorAlert
			v-if="error"
			class="mt-3"
			:message="t(`${P}.loadError`)"
			:action-label="t('common.tryAgain')"
			:action-icon="ReloadIcon"
			@action="refetch"
		/>
		<UiErrorAlert v-if="saveError" class="mt-3" :message="saveError" />

		<form
			v-if="isEditing && data"
			class="mt-4 space-y-4"
			data-testid="template-sender-form"
			@submit.prevent="save"
		>
			<TransactionalSenderAddressField
				v-model="draft"
				:domains="data.sendingDomains"
				:disabled="isSaving"
			/>
			<div class="flex flex-wrap justify-end gap-2">
				<UiButton variant="secondary" size="sm" :disabled="isSaving" @click="isEditing = false">
					{{ t('common.cancel') }}
				</UiButton>
				<UiButton type="submit" size="sm" :loading="isSaving" :disabled="!canSave">
					{{ t(`${P}.save`) }}
				</UiButton>
			</div>
		</form>
	</section>
</template>
