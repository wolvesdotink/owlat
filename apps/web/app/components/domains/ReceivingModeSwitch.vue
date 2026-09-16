<script setup lang="ts">
/**
 * Change who receives mail for an ALREADY-ADDED domain.
 *
 * The add-form asks the question once; this is the only way to answer it
 * differently later, and the answer has to be changeable because the common
 * case is someone who added the domain before they understood what the apex MX
 * record would do to their Google Workspace inbound mail.
 *
 * Three things make this deliberately more than a toggle:
 *
 *  - it is STAGED. The choice component is the same one the add-form uses, but
 *    the picks land in a local draft; nothing is written until the operator
 *    confirms. Flipping a live radio would regenerate DNS records under someone
 *    who was only reading the options.
 *  - it CONFIRMS, because the write is not cosmetic: the backend regenerates the
 *    apex SPF record (merged with the provider's include, or unmerged again) and
 *    adds/removes TLS-RPT, clears those verification results and drops the
 *    domain back to `pending`. A verified domain becomes unverified, and the
 *    operator has to re-publish and re-verify. Saying so before the click is the
 *    difference between a change and a surprise.
 *  - it never asks whether the domain is "correct". Both modes are supported
 *    configurations, so the current state renders as a plain fact, not a warning.
 *
 * Admin-only by the same gate as the DMARC selector (`organization:manage`);
 * the row decides whether to mount this at all, and the backend re-checks.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { ExternalReceivingProvider } from '@owlat/shared/externalReceiving';
import type { ReceivingMode } from '~/composables/useAddDomainForm';
import {
	DEFAULT_EXTERNAL_RECEIVING_PROVIDER,
	EXTERNAL_RECEIVING_PROVIDER_KEYS,
} from '~/utils/externalReceivingLabels';

const props = defineProps<{
	domainId: Id<'domains'>;
	/** The domain name, named in the confirmation so the dialog is unambiguous. */
	domain: string;
	/** The stored mode. Absent on every pre-existing row, which means `'owlat'`. */
	mode: ReceivingMode;
	/** The stored provider, when the mode is `'external'`. */
	provider: ExternalReceivingProvider | null | undefined;
}>();

const { t } = useI18n();
const { showToast } = useToast();

const { run: setReceivingMode, isLoading: isSaving } = useBackendOperation(
	api.domains.domains.setReceivingMode,
	{ label: () => t('components.domains.receivingModeSwitch.operation') }
);

const editing = ref(false);
const confirmOpen = ref(false);
const draftMode = ref<ReceivingMode>(props.mode);
const draftProvider = ref<ExternalReceivingProvider>(
	props.provider ?? DEFAULT_EXTERNAL_RECEIVING_PROVIDER
);

/** Sentence-form summary of what is stored right now. */
const currentLabel = computed(() =>
	props.mode === 'external'
		? t('components.domains.receivingModeSwitch.current.external', {
				provider: t(EXTERNAL_RECEIVING_PROVIDER_KEYS[props.provider ?? 'other']),
			})
		: t('components.domains.receivingModeSwitch.current.owlat')
);

// Nothing to save when the draft matches what is stored. Guarding here (rather
// than letting the mutation no-op) keeps a verified domain from being dropped to
// `pending` by a Save that changed nothing.
const isDirty = computed(
	() =>
		draftMode.value !== props.mode ||
		(draftMode.value === 'external' &&
			draftProvider.value !== (props.provider ?? DEFAULT_EXTERNAL_RECEIVING_PROVIDER))
);

// Re-seed the draft from the row every time the panel opens: the row is a live
// subscription, so a stale draft could otherwise re-submit a value someone else
// already changed.
function startEditing() {
	draftMode.value = props.mode;
	draftProvider.value = props.provider ?? DEFAULT_EXTERNAL_RECEIVING_PROVIDER;
	editing.value = true;
}

async function save() {
	const nextMode = draftMode.value;
	const result = await setReceivingMode({
		domainId: props.domainId,
		mode: nextMode,
		// The provider is meaningless in `'owlat'` mode; omitting it lets the
		// backend clear the field rather than leaving a stale brand on the row.
		...(nextMode === 'external' ? { provider: draftProvider.value } : {}),
	});
	confirmOpen.value = false;
	if (!result.ok) return; // run() already surfaced the failure
	editing.value = false;
	showToast(
		nextMode === 'external'
			? t('components.domains.receivingModeSwitch.toasts.external')
			: t('components.domains.receivingModeSwitch.toasts.owlat')
	);
}
</script>

<template>
	<div class="mt-4" data-testid="receiving-mode-switch">
		<p class="text-xs font-medium text-text-tertiary uppercase tracking-wider mb-2">
			{{ t('components.domains.receivingModeSwitch.heading') }}
		</p>

		<div v-if="!editing" class="flex flex-wrap items-center justify-between gap-3">
			<p class="text-sm text-text-secondary" data-testid="receiving-mode-current">
				{{ currentLabel }}
			</p>
			<UiButton
				variant="secondary"
				class="text-sm py-1.5 px-3"
				data-testid="receiving-mode-change"
				@click="startEditing"
			>
				{{ t('components.domains.receivingModeSwitch.change') }}
			</UiButton>
		</div>

		<div v-else class="rounded-xl border border-border-subtle bg-bg-surface p-4">
			<DomainsReceivingModeChoice
				v-model:mode="draftMode"
				v-model:provider="draftProvider"
				:disabled="isSaving"
			/>

			<!-- The cost of the change, before the click. -->
			<p class="mt-3 flex items-start gap-2 text-xs text-warning">
				<Icon name="lucide:alert-triangle" class="mt-0.5 h-3.5 w-3.5 shrink-0" />
				<span>{{ t('components.domains.receivingModeSwitch.consequence') }}</span>
			</p>

			<div class="mt-3 flex justify-end gap-2">
				<UiButton
					variant="secondary"
					class="text-sm py-1.5 px-3"
					:disabled="isSaving"
					@click="editing = false"
				>
					{{ t('common.cancel') }}
				</UiButton>
				<UiButton
					class="text-sm py-1.5 px-3"
					:disabled="isSaving || !isDirty"
					data-testid="receiving-mode-save"
					@click="confirmOpen = true"
				>
					{{ t('components.domains.receivingModeSwitch.save') }}
				</UiButton>
			</div>
		</div>

		<UiConfirmationDialog
			v-model:open="confirmOpen"
			:title="t('components.domains.receivingModeSwitch.confirm.title')"
			:description="
				t('components.domains.receivingModeSwitch.confirm.description', { domain: domain })
			"
			:confirm-text="t('components.domains.receivingModeSwitch.confirm.action')"
			variant="warning"
			:is-loading="isSaving"
			@confirm="save"
		/>
	</div>
</template>
