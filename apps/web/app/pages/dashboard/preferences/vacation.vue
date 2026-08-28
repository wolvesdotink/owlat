<script setup lang="ts">
import { api } from '@owlat/api';

const { t } = useI18n();

useHead({ title: () => t('dashboard.preferences.vacation.pageTitle') });

definePageMeta({
	layout: 'preferences',
	middleware: 'auth',
	requiresAnyFeature: ['postbox', 'mail.external'],
});

const { currentMailbox, isLoading: mailboxesLoading } = usePostboxMailbox();
const mailboxId = computed(() => currentMailbox.value?._id ?? null);

const { data, isLoading } = useConvexQuery(api.mail.vacation.get, () =>
	mailboxId.value ? { mailboxId: mailboxId.value } : 'skip'
);
const error = ref<string | null>(null);
const saving = ref(false);

const upsertMutation = useBackendOperation(api.mail.vacation.upsert, {
	label: () => t('dashboard.preferences.vacation.saveOperation'),
	inlineTarget: error,
});
const removeMutation = useBackendOperation(api.mail.vacation.remove, {
	label: () => t('dashboard.preferences.vacation.turnOffOperation'),
});

const draft = reactive({
	enabled: false,
	subject: t('dashboard.preferences.vacation.defaultSubject'),
	bodyText: t('dashboard.preferences.vacation.defaultBody'),
	startAt: '',
	endAt: '',
	replyIntervalDays: 7,
});

watch(
	data,
	(loaded) => {
		if (!loaded) return;
		draft.enabled = loaded.isEnabled;
		draft.subject = loaded.subject;
		draft.bodyText = loaded.bodyText;
		draft.startAt = loaded.startAt ? new Date(loaded.startAt).toISOString().slice(0, 16) : '';
		draft.endAt = loaded.endAt ? new Date(loaded.endAt).toISOString().slice(0, 16) : '';
		draft.replyIntervalDays = loaded.replyIntervalDays;
	},
	{ immediate: true }
);

async function save() {
	if (!mailboxId.value) return;
	saving.value = true;
	await upsertMutation.run({
		mailboxId: mailboxId.value,
		isEnabled: draft.enabled,
		subject: draft.subject,
		bodyText: draft.bodyText,
		startAt: draft.startAt ? new Date(draft.startAt).getTime() : undefined,
		endAt: draft.endAt ? new Date(draft.endAt).getTime() : undefined,
		replyIntervalDays: draft.replyIntervalDays,
	});
	saving.value = false;
}

const showDisableConfirm = ref(false);

async function confirmDisable() {
	if (!mailboxId.value) return;
	const result = await removeMutation.run({ mailboxId: mailboxId.value });
	showDisableConfirm.value = false;
	if (!result.ok) return;
	draft.enabled = false;
}
</script>

<template>
	<div>
		<header class="mb-6">
			<p class="text-text-secondary">
				{{ t('dashboard.preferences.vacation.intro') }}
			</p>
		</header>

		<section v-if="mailboxId" class="card p-5 space-y-4">
			<label class="flex items-center gap-2">
				<input v-model="draft.enabled" type="checkbox" />
				<span class="font-medium">{{ t('dashboard.preferences.vacation.enabledLabel') }}</span>
			</label>

			<div>
				<label for="draft-subject" class="text-sm font-medium block mb-1">
					{{ t('dashboard.preferences.vacation.subject') }}
				</label>
				<input id="draft-subject" v-model="draft.subject" type="text" class="input w-full" />
			</div>

			<div>
				<label for="draft-bodytext" class="text-sm font-medium block mb-1">
					{{ t('dashboard.preferences.vacation.message') }}
				</label>
				<textarea
					id="draft-bodytext"
					v-model="draft.bodyText"
					rows="6"
					class="input w-full font-sans"
				/>
			</div>

			<div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
				<div>
					<label for="draft-startat" class="text-sm font-medium block mb-1">
						{{ t('dashboard.preferences.vacation.start') }}
					</label>
					<input
						id="draft-startat"
						v-model="draft.startAt"
						type="datetime-local"
						class="input w-full"
					/>
				</div>
				<div>
					<label for="draft-endat" class="text-sm font-medium block mb-1">
						{{ t('dashboard.preferences.vacation.end') }}
					</label>
					<input
						id="draft-endat"
						v-model="draft.endAt"
						type="datetime-local"
						class="input w-full"
					/>
				</div>
				<div>
					<label for="draft-replyintervaldays" class="text-sm font-medium block mb-1">
						{{ t('dashboard.preferences.vacation.replyInterval') }}
					</label>
					<input
						id="draft-replyintervaldays"
						v-model.number="draft.replyIntervalDays"
						type="number"
						min="1"
						max="30"
						class="input w-full"
					/>
				</div>
			</div>

			<p v-if="error" class="text-sm text-error">{{ error }}</p>

			<div class="flex items-center justify-end gap-2 pt-2">
				<UiButton
					variant="ghost"
					v-if="data"
					type="button"
					class="text-error"
					@click="showDisableConfirm = true"
				>
					{{ t('dashboard.preferences.vacation.turnOff') }}
				</UiButton>
				<UiButton type="button" :disabled="saving" @click="save">
					<Icon v-if="saving" name="lucide:loader-2" class="w-4 h-4 mr-1.5 animate-spin" />
					{{ saving ? t('common.saving') : t('common.save') }}
				</UiButton>
			</div>
		</section>

		<div v-if="!mailboxId && !mailboxesLoading" class="card p-6 text-center text-text-secondary">
			{{ t('dashboard.preferences.vacation.noMailbox') }}
		</div>

		<UiConfirmationDialog
			:open="showDisableConfirm"
			variant="warning"
			:title="t('dashboard.preferences.vacation.turnOffTitle')"
			:description="t('dashboard.preferences.vacation.turnOffDescription')"
			:confirm-text="t('dashboard.preferences.vacation.turnOff')"
			:is-loading="removeMutation.isLoading.value"
			@update:open="(v: boolean) => !v && (showDisableConfirm = false)"
			@confirm="confirmDisable"
		/>
	</div>
</template>
