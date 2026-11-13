<script setup lang="ts">
import { api } from '@owlat/api';

const { t } = useI18n();

useHead({ title: () => t('dashboard.preferences.vacation.pageTitle') });

definePageMeta({
	layout: 'preferences',
	middleware: 'auth',
	requiresAnyFeature: ['postbox', 'mail.external'],
});

const {
	currentMailbox,
	isLoading: mailboxesLoading,
	error: mailboxesError,
	refetch: refetchMailboxes,
} = usePostboxMailbox();
const mailboxId = computed(() => currentMailbox.value?._id ?? null);

const {
	data,
	error: readError,
	refetch,
} = useConvexQuery(api.mail.vacation.get, () =>
	mailboxId.value ? { mailboxId: mailboxId.value } : 'skip'
);
// `null` is an answer (no responder stored yet); `undefined` is a read still
// loading or one that failed. Only an answer may seed the form: a save upserts
// every field, so a form seeded with the defaults would switch off an active
// responder and replace its text.
const loaded = computed(() => data.value !== undefined);
const error = ref<string | null>(null);
const saving = ref(false);

const upsertMutation = useBackendOperation(api.mail.vacation.upsert, {
	label: () => t('dashboard.preferences.vacation.saveOperation'),
	inlineTarget: error,
});
const removeMutation = useBackendOperation(api.mail.vacation.remove, {
	label: () => t('dashboard.preferences.vacation.turnOffOperation'),
});

const defaultDraft = () => ({
	enabled: false,
	subject: t('dashboard.preferences.vacation.defaultSubject'),
	bodyText: t('dashboard.preferences.vacation.defaultBody'),
	startAt: '',
	endAt: '',
	replyIntervalDays: 7,
});

const draft = reactive(defaultDraft());

/**
 * A stored instant as the wall-clock value a `datetime-local` input shows.
 * The input has no zone and the save parses it as local time, so it must be
 * rendered in local time too; `toISOString()` would show UTC and shift the
 * window by the zone offset on every save.
 */
function toLocalInputValue(ts: number): string {
	const d = new Date(ts);
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

watch(
	data,
	(stored) => {
		if (stored === undefined) return;
		// No responder on this mailbox: the defaults, not the previous mailbox's.
		if (stored === null) {
			Object.assign(draft, defaultDraft());
			return;
		}
		draft.enabled = stored.isEnabled;
		draft.subject = stored.subject;
		draft.bodyText = stored.bodyText;
		draft.startAt = stored.startAt ? toLocalInputValue(stored.startAt) : '';
		draft.endAt = stored.endAt ? toLocalInputValue(stored.endAt) : '';
		draft.replyIntervalDays = stored.replyIntervalDays;
	},
	{ immediate: true }
);

async function save() {
	if (!mailboxId.value || !loaded.value) return;
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

		<UiQueryBoundary v-if="mailboxId" :loading="!loaded" :error="readError" @retry="refetch">
			<template #loading>
				<div
					class="card p-5 space-y-4"
					role="status"
					aria-busy="true"
					:aria-label="t('common.loading')"
				>
					<UiSkeleton class="h-6 w-48" />
					<UiSkeleton class="h-10 rounded-lg" />
					<UiSkeleton class="h-32 rounded-lg" />
					<UiSkeleton class="h-10 rounded-lg" />
				</div>
			</template>

			<section class="card p-5 space-y-4">
				<label class="flex items-center justify-between gap-4">
					<span class="font-medium">{{ t('dashboard.preferences.vacation.enabledLabel') }}</span>
					<UiSwitch v-model="draft.enabled" />
				</label>

				<div>
					<label for="draft-subject" class="label">
						{{ t('dashboard.preferences.vacation.subject') }}
					</label>
					<input id="draft-subject" v-model="draft.subject" type="text" class="input w-full" />
				</div>

				<div>
					<label for="draft-bodytext" class="label">
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
						<label for="draft-startat" class="label">
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
						<label for="draft-endat" class="label">
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
						<label for="draft-replyintervaldays" class="label">
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
					<!-- Deletes the stored responder, text included; the switch above
					     pauses it and keeps the text. -->
					<UiButton
						v-if="data"
						variant="danger-ghost"
						type="button"
						@click="showDisableConfirm = true"
					>
						{{ t('dashboard.preferences.vacation.turnOff') }}
					</UiButton>
					<UiButton type="button" :disabled="!loaded" :loading="saving" @click="save">
						{{ saving ? t('common.saving') : t('common.save') }}
					</UiButton>
				</div>
			</section>
		</UiQueryBoundary>

		<UiQueryBoundary v-else-if="mailboxesError" :error="mailboxesError" @retry="refetchMailboxes" />
		<div v-else-if="!mailboxesLoading" class="card p-6 text-center text-text-secondary">
			{{ t('dashboard.preferences.vacation.noMailbox') }}
		</div>

		<UiConfirmationDialog
			:open="showDisableConfirm"
			variant="danger"
			:title="t('dashboard.preferences.vacation.turnOffTitle')"
			:description="t('dashboard.preferences.vacation.turnOffDescription')"
			:confirm-text="t('dashboard.preferences.vacation.turnOff')"
			:is-loading="removeMutation.isLoading.value"
			@update:open="(v: boolean) => !v && (showDisableConfirm = false)"
			@confirm="confirmDisable"
		/>
	</div>
</template>
