<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

useHead({ title: 'Forwarding — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	requiresAnyFeature: ['postbox', 'mail.external'],
});

const { currentMailbox, isLoading: mailboxesLoading } = usePostboxMailbox();
const mailboxId = computed(() => currentMailbox.value?._id ?? null);

const { data, isLoading } = useConvexQuery(api.mail.forwarding.list, () =>
	mailboxId.value ? { mailboxId: mailboxId.value } : 'skip'
);
const rules = computed(() => data.value ?? []);

const newAddress = ref('');
const keepLocal = ref(true);
const error = ref<string | null>(null);
const submitting = ref(false);

const createMutation = useBackendOperation(api.mail.forwarding.create, {
	label: 'Add forwarding rule',
	inlineTarget: error,
});
const updateMutation = useBackendOperation(api.mail.forwarding.update, {
	label: 'Update forwarding rule',
});
const removeMutation = useBackendOperation(api.mail.forwarding.remove, {
	label: 'Remove forwarding rule',
});

async function handleCreate() {
	if (!mailboxId.value) return;
	const trimmed = newAddress.value.trim();
	if (!trimmed) return;
	submitting.value = true;
	const result = await createMutation.run({
		mailboxId: mailboxId.value,
		forwardTo: trimmed,
		keepLocalCopy: keepLocal.value,
	});
	submitting.value = false;
	if (result === undefined) return;
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
	if (result === undefined) return;
}
</script>

<template>
	<div class="p-6 lg:p-8 max-w-3xl mx-auto">
		<NuxtLink
			to="/dashboard/postbox/settings"
			class="text-sm text-text-secondary inline-flex items-center gap-1 hover:text-text-primary mb-4"
		>
			<Icon name="lucide:arrow-left" class="w-3.5 h-3.5" />
			Back to settings
		</NuxtLink>

		<header class="mb-6">
			<h1 class="text-2xl font-semibold">Forwarding</h1>
			<p class="text-text-secondary mt-1">
				Auto-forward inbound mail to an external address. Mailing-list and
				auto-submitted mail is skipped to prevent loops.
			</p>
		</header>

		<form
			v-if="mailboxId"
			class="card p-4 mb-4 flex items-end gap-2"
			@submit.prevent="handleCreate"
		>
			<div class="flex-1">
				<label for="newaddress" class="text-sm font-medium block mb-1">Forward to</label>
				<input id="newaddress"
					v-model="newAddress"
					type="text"
					class="input w-full"
					placeholder="archive@example.com"
				/>
			</div>
			<label class="flex items-center gap-1.5 text-sm pb-2">
				<input v-model="keepLocal" type="checkbox" />
				Keep local copy
			</label>
			<button type="submit" class="btn btn-primary" :disabled="!newAddress.trim() || submitting">
				Add
			</button>
		</form>
		<p v-if="error" class="text-sm text-error mb-4">{{ error }}</p>

		<section v-if="mailboxId" class="card !p-0">
			<header class="px-5 py-3 border-b border-border-subtle">
				<h2 class="font-semibold">Active rules</h2>
			</header>
			<div v-if="isLoading" class="p-8 flex justify-center">
				<Icon name="lucide:loader-2" class="w-5 h-5 animate-spin text-text-tertiary" />
			</div>
			<div v-else-if="rules.length === 0" class="p-8 text-center text-text-secondary">
				No forwarding rules yet.
			</div>
			<ul v-else class="divide-y divide-border-subtle">
				<li
					v-for="rule in rules"
					:key="rule._id"
					class="px-5 py-3 flex items-center justify-between gap-3"
				>
					<div class="flex-1 min-w-0">
						<p class="font-mono text-sm">→ {{ rule.forwardTo }}</p>
						<p class="text-xs text-text-tertiary">
							{{ rule.keepLocalCopy ? 'Keep local copy' : 'Forward only (no inbox copy)' }}
						</p>
					</div>
					<label class="flex items-center gap-1.5 text-sm">
						<input
							type="checkbox"
							:checked="rule.isEnabled"
							@change="handleToggle(rule._id, ($event.target as HTMLInputElement).checked)"
						/>
						Enabled
					</label>
					<button
						type="button"
						class="btn btn-ghost text-error"
						@click="ruleToRemove = rule._id"
					>
						Remove
					</button>
				</li>
			</ul>
		</section>

		<div v-if="!mailboxId && !mailboxesLoading" class="card p-6 text-center text-text-secondary">
			No mailbox configured.
		</div>

		<UiConfirmationDialog
			:open="!!ruleToRemove"
			variant="danger"
			title="Remove forwarding rule?"
			description="Inbound mail will no longer be forwarded to this address."
			confirm-text="Remove rule"
			:is-loading="removeMutation.isLoading.value"
			@update:open="(v: boolean) => !v && (ruleToRemove = null)"
			@confirm="confirmRemove"
		/>
	</div>
</template>
