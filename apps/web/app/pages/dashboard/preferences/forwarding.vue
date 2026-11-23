<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { SpinnerIcon } from '@owlat/ui/icons/SpinnerIcon';

const { t } = useI18n();

useHead({ title: () => t('dashboard.preferences.forwarding.pageTitle') });

definePageMeta({
	layout: 'preferences',
	middleware: 'auth',
});

const {
	mailboxes,
	currentMailbox,
	mailboxId,
	selectMailbox,
	isLoading: mailboxesLoading,
	error: mailboxesError,
	refetch: refetchMailboxes,
} = usePostboxSettingsMailbox('owner', {
	onSwitch: () => {
		newAddress.value = '';
		error.value = null;
	},
});

// Forwarding runs on mail Owlat receives itself; a connected mailbox's mail
// arrives at its provider, so a rule here would never run.
const isConnected = computed(() => currentMailbox.value?.kind === 'external');

const {
	data,
	isLoading,
	error: listError,
	refetch: refetchList,
} = useConvexQuery(api.mail.forwarding.list, () =>
	mailboxId.value && !isConnected.value ? { mailboxId: mailboxId.value } : 'skip'
);
const rules = computed(() => data.value ?? []);

const newAddress = ref('');
const error = ref<string | null>(null);
const submitting = ref(false);

const createMutation = useBackendOperation(api.mail.forwarding.create, {
	label: () => t('dashboard.preferences.forwarding.createOperation'),
	inlineTarget: error,
});
const updateMutation = useBackendOperation(api.mail.forwarding.update, {
	label: () => t('dashboard.preferences.forwarding.updateOperation'),
});
const removeMutation = useBackendOperation(api.mail.forwarding.remove, {
	label: () => t('dashboard.preferences.forwarding.removeOperation'),
});

async function handleCreate() {
	if (!mailboxId.value) return;
	const trimmed = newAddress.value.trim();
	if (!trimmed) return;
	submitting.value = true;
	const result = await createMutation.run({
		mailboxId: mailboxId.value,
		forwardTo: trimmed,
	});
	submitting.value = false;
	if (!result.ok) return;
	newAddress.value = '';
}

async function handleToggle(id: Id<'mailForwarding'>, enabled: boolean) {
	await updateMutation.run({ id, isEnabled: enabled });
}
const ruleToRemove = ref<Id<'mailForwarding'> | null>(null);

async function confirmRemove() {
	const id = ruleToRemove.value;
	if (!id) return;
	const result = await removeMutation.run({ id });
	ruleToRemove.value = null;
	if (!result.ok) return;
}
</script>

<template>
	<div>
		<PreferencesMailboxPicker
			v-if="mailboxId"
			:mailboxes="mailboxes"
			:mailbox-id="mailboxId"
			:locked="newAddress.trim() !== ''"
			@select="selectMailbox"
		/>
		<header class="mb-6">
			<p class="text-text-secondary">
				{{ t('dashboard.preferences.forwarding.intro') }}
			</p>
		</header>

		<p
			v-if="mailboxId && isConnected"
			class="card p-6 text-text-secondary"
			data-testid="connected-mailbox-notice"
		>
			{{
				t('dashboard.preferences.forwarding.connectedNotice', {
					address: currentMailbox?.address,
				})
			}}
		</p>

		<form
			v-if="mailboxId && !isConnected"
			class="card p-4 mb-4 flex flex-wrap items-end gap-x-2 gap-y-3"
			@submit.prevent="handleCreate"
		>
			<div class="min-w-0 flex-[1_1_16rem]">
				<label for="newaddress" class="label">
					{{ t('dashboard.preferences.forwarding.forwardTo') }}
				</label>
				<input
					id="newaddress"
					v-model="newAddress"
					type="email"
					autocomplete="email"
					class="input w-full"
					:placeholder="t('dashboard.preferences.forwarding.addressPlaceholder')"
				/>
			</div>
			<UiButton type="submit" class="ml-auto" :disabled="!newAddress.trim()" :loading="submitting">
				{{ t('common.add') }}
			</UiButton>
		</form>
		<p v-if="error" class="text-sm text-error mb-4">{{ error }}</p>

		<section v-if="mailboxId && !isConnected" class="card !p-0">
			<header class="px-5 py-3 border-b border-border-subtle">
				<h2 class="font-semibold">{{ t('dashboard.preferences.forwarding.activeRules') }}</h2>
			</header>
			<div v-if="isLoading" class="p-8 flex justify-center">
				<SpinnerIcon class="w-5 h-5 text-text-tertiary" />
			</div>
			<!-- A failed read is not an empty list. -->
			<UiQueryBoundary v-else-if="listError" :error="listError" @retry="refetchList" />
			<div v-else-if="rules.length === 0" class="p-8 text-center text-text-secondary">
				{{ t('dashboard.preferences.forwarding.empty') }}
			</div>
			<ul v-else class="divide-y divide-border-subtle">
				<li
					v-for="rule in rules"
					:key="rule._id"
					class="px-5 py-3 flex items-center justify-between gap-3"
				>
					<p class="flex-1 min-w-0 font-mono text-sm break-all">→ {{ rule.forwardTo }}</p>
					<UiSwitch
						:model-value="rule.isEnabled"
						:label="t('dashboard.preferences.forwarding.ruleSwitch', { address: rule.forwardTo })"
						@update:model-value="handleToggle(rule._id, $event)"
					/>
					<UiButton
						variant="danger-ghost"
						type="button"
						class="shrink-0"
						:aria-label="`${t('common.remove')}: ${rule.forwardTo}`"
						@click="ruleToRemove = rule._id"
					>
						{{ t('common.remove') }}
					</UiButton>
				</li>
			</ul>
		</section>

		<UiQueryBoundary
			v-if="!mailboxId && mailboxesError"
			:error="mailboxesError"
			@retry="refetchMailboxes"
		/>
		<div
			v-else-if="!mailboxId && !mailboxesLoading"
			class="card p-6 text-center text-text-secondary"
		>
			{{ t('dashboard.preferences.forwarding.noMailbox') }}
		</div>

		<UiConfirmationDialog
			:open="!!ruleToRemove"
			variant="danger"
			:title="t('dashboard.preferences.forwarding.removeTitle')"
			:description="t('dashboard.preferences.forwarding.removeDescription')"
			:confirm-text="t('dashboard.preferences.forwarding.removeConfirm')"
			:is-loading="removeMutation.isLoading.value"
			@update:open="(v: boolean) => !v && (ruleToRemove = null)"
			@confirm="confirmRemove"
		/>
	</div>
</template>
