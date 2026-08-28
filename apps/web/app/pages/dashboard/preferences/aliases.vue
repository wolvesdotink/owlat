<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

const { t } = useI18n();

useHead({ title: () => t('dashboard.preferences.aliases.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	requiresAnyFeature: ['postbox', 'mail.external'],
});

const { currentMailbox, isLoading: mailboxesLoading } = usePostboxMailbox();
const mailboxId = computed(() => currentMailbox.value?._id ?? null);

const { data, isLoading } = useConvexQuery(api.mail.aliases.list, () =>
	mailboxId.value ? { mailboxId: mailboxId.value } : 'skip'
);
const aliases = computed(() => data.value ?? []);

const newAlias = ref('');
const error = ref<string | null>(null);
const submitting = ref(false);

const createMutation = useBackendOperation(api.mail.aliases.create, {
	label: () => t('dashboard.preferences.aliases.addAliasOperation'),
	inlineTarget: error,
});
const removeMutation = useBackendOperation(api.mail.aliases.remove, {
	label: () => t('dashboard.preferences.aliases.removeAliasOperation'),
});

async function handleCreate() {
	if (!mailboxId.value) return;
	const trimmed = newAlias.value.trim();
	if (!trimmed) return;
	submitting.value = true;
	const result = await createMutation.run({ mailboxId: mailboxId.value, alias: trimmed });
	submitting.value = false;
	if (!result.ok) return;
	newAlias.value = '';
}

const aliasToRemove = ref<Id<'mailAliases'> | null>(null);

async function confirmRemove() {
	const id = aliasToRemove.value;
	if (!id) return;
	const result = await removeMutation.run({ aliasId: id });
	aliasToRemove.value = null;
	if (!result.ok) return;
}
</script>

<template>
	<div class="p-6 lg:p-8 max-w-3xl mx-auto">
		<PreferencesBackLink />

		<header class="mb-6">
			<h1 class="text-2xl font-medium tracking-[-0.02em]">
				{{ t('dashboard.preferences.aliases.heading') }}
			</h1>
			<I18nT
				keypath="dashboard.preferences.aliases.subheading"
				tag="p"
				scope="global"
				class="text-text-secondary mt-1"
			>
				<template #address>
					<span v-if="currentMailbox" class="font-mono text-sm">{{ currentMailbox.address }}</span>
				</template>
			</I18nT>
		</header>

		<form
			v-if="mailboxId"
			class="card p-4 mb-4 flex items-center gap-2"
			@submit.prevent="handleCreate"
		>
			<input
				v-model="newAlias"
				type="text"
				class="input flex-1"
				:placeholder="t('dashboard.preferences.aliases.aliasPlaceholder')"
			/>
			<UiButton type="submit" :disabled="!newAlias.trim() || submitting">
				{{ t('dashboard.preferences.aliases.addAlias') }}
			</UiButton>
		</form>
		<p v-if="error" class="text-sm text-error mb-4">{{ error }}</p>

		<section v-if="mailboxId" class="card !p-0">
			<header class="px-5 py-3 border-b border-border-subtle">
				<h2 class="font-semibold">{{ t('dashboard.preferences.aliases.activeAliases') }}</h2>
			</header>
			<div v-if="isLoading" class="p-8 flex justify-center">
				<Icon name="lucide:loader-2" class="w-5 h-5 animate-spin text-text-tertiary" />
			</div>
			<div v-else-if="aliases.length === 0" class="p-8 text-center text-text-secondary">
				{{ t('dashboard.preferences.aliases.empty') }}
			</div>
			<ul v-else class="divide-y divide-border-subtle">
				<li
					v-for="alias in aliases"
					:key="alias._id"
					class="px-5 py-3 flex items-center justify-between"
				>
					<span class="font-mono text-sm">{{ alias.alias }}</span>
					<UiButton
						variant="ghost"
						type="button"
						class="text-error"
						@click="aliasToRemove = alias._id"
					>
						{{ t('common.remove') }}
					</UiButton>
				</li>
			</ul>
		</section>

		<div v-if="!mailboxId && !mailboxesLoading" class="card p-6 text-center text-text-secondary">
			{{ t('dashboard.preferences.aliases.noMailbox') }}
		</div>

		<UiConfirmationDialog
			:open="!!aliasToRemove"
			variant="danger"
			:title="t('dashboard.preferences.aliases.removeDialogTitle')"
			:description="t('dashboard.preferences.aliases.removeDialogDescription')"
			:confirm-text="t('dashboard.preferences.aliases.removeAlias')"
			:is-loading="removeMutation.isLoading.value"
			@update:open="(v: boolean) => !v && (aliasToRemove = null)"
			@confirm="confirmRemove"
		/>
	</div>
</template>
