<script setup lang="ts">
import { api } from '@owlat/api';

useHead({ title: 'Vacation auto-reply — Owlat' });

definePageMeta({
	layout: 'dashboard',
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
	label: 'Save auto-reply',
	inlineTarget: error,
});
const removeMutation = useBackendOperation(api.mail.vacation.remove, {
	label: 'Turn off auto-reply',
});

const draft = reactive({
	enabled: false,
	subject: 'Out of office',
	bodyText: 'I\'m away from email and will respond when I return.',
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
		draft.startAt = loaded.startAt
			? new Date(loaded.startAt).toISOString().slice(0, 16)
			: '';
		draft.endAt = loaded.endAt
			? new Date(loaded.endAt).toISOString().slice(0, 16)
			: '';
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
	if (result === undefined) return;
	draft.enabled = false;
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
			<h1 class="text-2xl font-semibold">Vacation auto-reply</h1>
			<p class="text-text-secondary mt-1">
				Reply once per sender per N days while you're away. Mailing-list and
				auto-submitted mail is silently skipped (RFC 3834).
			</p>
		</header>

		<section v-if="mailboxId" class="card p-5 space-y-4">
			<label class="flex items-center gap-2">
				<input v-model="draft.enabled" type="checkbox" />
				<span class="font-medium">Auto-reply enabled</span>
			</label>

			<div>
				<label for="draft-subject" class="text-sm font-medium block mb-1">Subject</label>
				<input id="draft-subject" v-model="draft.subject" type="text" class="input w-full" />
			</div>

			<div>
				<label for="draft-bodytext" class="text-sm font-medium block mb-1">Message</label>
				<textarea id="draft-bodytext"
					v-model="draft.bodyText"
					rows="6"
					class="input w-full font-sans"
				/>
			</div>

			<div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
				<div>
					<label for="draft-startat" class="text-sm font-medium block mb-1">Start (optional)</label>
					<input id="draft-startat" v-model="draft.startAt" type="datetime-local" class="input w-full" />
				</div>
				<div>
					<label for="draft-endat" class="text-sm font-medium block mb-1">End (optional)</label>
					<input id="draft-endat" v-model="draft.endAt" type="datetime-local" class="input w-full" />
				</div>
				<div>
					<label for="draft-replyintervaldays" class="text-sm font-medium block mb-1">Reply once per N days</label>
					<input id="draft-replyintervaldays"
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
				<button
					v-if="data"
					type="button"
					class="btn btn-ghost text-error"
					@click="showDisableConfirm = true"
				>
					Turn off
				</button>
				<button type="button" class="btn btn-primary" :disabled="saving" @click="save">
					<Icon
						v-if="saving"
						name="lucide:loader-2"
						class="w-4 h-4 mr-1.5 animate-spin"
					/>
					{{ saving ? 'Saving…' : 'Save' }}
				</button>
			</div>
		</section>

		<div v-if="!mailboxId && !mailboxesLoading" class="card p-6 text-center text-text-secondary">
			No mailbox configured.
		</div>

		<UiConfirmationDialog
			:open="showDisableConfirm"
			variant="warning"
			title="Turn off auto-reply?"
			description="The vacation auto-responder will stop replying to incoming mail."
			confirm-text="Turn off"
			:is-loading="removeMutation.isLoading.value"
			@update:open="(v: boolean) => !v && (showDisableConfirm = false)"
			@confirm="confirmDisable"
		/>
	</div>
</template>
