<script setup lang="ts">
/**
 * Add or remove a domain's optional second DKIM key (Ed25519), under the
 * domain's sender-authentication records. Only for domains the built-in MTA
 * sends for; the section decides that and passes `hasKey` from the record list.
 *
 * The record itself renders as its own row in the checklist above. Removing
 * the key asks first: the published record stops matching any key, and adding
 * one later gives a new selector to publish.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { FilePlusIcon, TrashIcon } from '@coolicons/vue';
import { SpinnerIcon } from '@owlat/ui/icons/SpinnerIcon';

const props = defineProps<{
	domainId: Id<'domains'>;
	domain: string;
	/** Whether the domain's DKIM records already list the Ed25519 key. */
	hasKey: boolean;
}>();

const { t } = useI18n();

const { run: addKey, isLoading: isAdding } = useBackendOperation(api.domains.dkimEd25519.addKey, {
	label: () => t('components.domains.dkimEd25519.operations.add'),
	type: 'action',
});
const { run: removeKey, isLoading: isRemoving } = useBackendOperation(
	api.domains.dkimEd25519.removeKey,
	{ label: () => t('components.domains.dkimEd25519.operations.remove'), type: 'action' }
);

const confirmingRemove = ref(false);

async function add() {
	await addKey({ domainId: props.domainId });
}

async function confirmRemove() {
	const result = await removeKey({ domainId: props.domainId });
	if (result.ok) confirmingRemove.value = false;
}
</script>

<template>
	<div
		class="mt-3 flex flex-col gap-3 rounded-xl border border-border-subtle bg-bg-surface p-4 sm:flex-row sm:items-center sm:justify-between"
		data-testid="dkim-ed25519-control"
	>
		<p class="text-sm text-text-secondary">
			{{
				hasKey
					? t('components.domains.dkimEd25519.present')
					: t('components.domains.dkimEd25519.absent')
			}}
		</p>
		<UiButton
			v-if="!hasKey"
			size="sm"
			variant="secondary"
			class="shrink-0 gap-1.5"
			:disabled="isAdding"
			data-testid="dkim-ed25519-add"
			@click="add"
		>
			<component
				:is="isAdding ? SpinnerIcon : FilePlusIcon"
				:class="['h-4 w-4', isAdding && 'animate-spin motion-reduce:animate-none']"
				size="1em"
			/>
			{{ t('components.domains.dkimEd25519.add') }}
		</UiButton>
		<UiButton
			v-else
			size="sm"
			variant="secondary"
			class="shrink-0 gap-1.5"
			:disabled="isRemoving"
			data-testid="dkim-ed25519-remove"
			@click="confirmingRemove = true"
		>
			<TrashIcon class="h-4 w-4" size="1em" />
			{{ t('components.domains.dkimEd25519.remove') }}
		</UiButton>
		<UiConfirmationDialog
			v-model:open="confirmingRemove"
			variant="danger"
			:title="t('components.domains.dkimEd25519.confirmRemove.title')"
			:description="t('components.domains.dkimEd25519.confirmRemove.description', { domain })"
			:confirm-text="t('components.domains.dkimEd25519.confirmRemove.confirm')"
			:is-loading="isRemoving"
			@confirm="confirmRemove"
		/>
	</div>
</template>
