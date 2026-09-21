<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

const { t } = useI18n();

useHead({ title: () => t('dashboard.preferences.forwarding.pageTitle') });

definePageMeta({
	layout: 'preferences',
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
		keepLocalCopy: keepLocal.value,
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
		<header class="mb-6">
			<p class="text-text-secondary">
				{{ t('dashboard.preferences.forwarding.intro') }}
			</p>
		</header>

		<form
			v-if="mailboxId"
			class="card p-4 mb-4 flex items-end gap-2"
			@submit.prevent="handleCreate"
		>
			<div class="flex-1">
				<label for="newaddress" class="text-sm font-medium block mb-1">
					{{ t('dashboard.preferences.forwarding.forwardTo') }}
				</label>
				<input
					id="newaddress"
					v-model="newAddress"
					type="text"
					class="input w-full"
					:placeholder="t('dashboard.preferences.forwarding.addressPlaceholder')"
				/>
			</div>
			<label class="flex items-center gap-1.5 text-sm pb-2">
				<input v-model="keepLocal" type="checkbox" />
				{{ t('dashboard.preferences.forwarding.keepLocalCopy') }}
			</label>
			<UiButton type="submit" :disabled="!newAddress.trim() || submitting">
				{{ t('common.add') }}
			</UiButton>
		</form>
		<p v-if="error" class="text-sm text-error mb-4">{{ error }}</p>

		<section v-if="mailboxId" class="card !p-0">
			<header class="px-5 py-3 border-b border-border-subtle">
				<h2 class="font-semibold">{{ t('dashboard.preferences.forwarding.activeRules') }}</h2>
			</header>
			<div v-if="isLoading" class="p-8 flex justify-center">
				<Icon name="lucide:loader-2" class="w-5 h-5 animate-spin motion-reduce:animate-none text-text-tertiary" />
			</div>
			<div v-else-if="rules.length === 0" class="p-8 text-center text-text-secondary">
				{{ t('dashboard.preferences.forwarding.empty') }}
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
							{{
								rule.keepLocalCopy
									? t('dashboard.preferences.forwarding.keepLocalCopy')
									: t('dashboard.preferences.forwarding.forwardOnly')
							}}
						</p>
					</div>
					<label class="flex items-center gap-1.5 text-sm">
						<input
							type="checkbox"
							:checked="rule.isEnabled"
							@change="handleToggle(rule._id, ($event.target as HTMLInputElement).checked)"
						/>
						{{ t('common.enabled') }}
					</label>
					<UiButton
						variant="ghost"
						type="button"
						class="text-error"
						@click="ruleToRemove = rule._id"
					>
						{{ t('common.remove') }}
					</UiButton>
				</li>
			</ul>
		</section>

		<div v-if="!mailboxId && !mailboxesLoading" class="card p-6 text-center text-text-secondary">
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
