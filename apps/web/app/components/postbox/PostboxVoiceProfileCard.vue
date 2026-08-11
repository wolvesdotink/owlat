<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

const props = defineProps<{
	mailboxId: Id<'mailboxes'>;
	address: string;
}>();

const { data, isLoading } = useConvexQuery(api.mail.voiceProfile.get, () => ({
	mailboxId: props.mailboxId,
}));

const setEnabled = useBackendOperation(api.mail.voiceProfile.setEnabled, {
	label: 'Update writing-voice personalization',
});
const refreshNow = useBackendOperation(api.mail.voiceProfile.requestRefresh, {
	label: 'Refresh writing voice',
});
const saveInstructions = useBackendOperation(api.mail.voiceProfile.setStandingInstructions, {
	label: 'Save writing instructions',
});
const removeAdjustment = useBackendOperation(api.mail.voiceProfile.removeDerivedAdjustment, {
	label: 'Remove learned writing rule',
});
const instructionDraft = ref('');

watch(
	() => data.value?.standingInstructions,
	(instructions) => {
		instructionDraft.value = (instructions ?? []).join('\n');
	},
	{ immediate: true }
);

const enabled = computed(() => data.value?.isEnabled ?? false);
const profile = computed(() => data.value?.profile ?? null);
const isRefreshing = computed(() => data.value?.status === 'refreshing');

const lastComputedLabel = computed(() => {
	const ts = data.value?.lastComputedAt;
	return ts ? new Date(ts).toLocaleString() : null;
});

async function onToggle(event: Event) {
	const next = (event.target as HTMLInputElement).checked;
	await setEnabled.run({ mailboxId: props.mailboxId, enabled: next });
}

async function onRefresh() {
	await refreshNow.run({ mailboxId: props.mailboxId });
}

async function onSaveInstructions() {
	await saveInstructions.run({
		mailboxId: props.mailboxId,
		instructions: instructionDraft.value.split('\n'),
	});
}

async function onRemoveAdjustment(kind: string) {
	await removeAdjustment.run({ mailboxId: props.mailboxId, kind });
}
</script>

<template>
	<section class="card !p-0">
		<header class="px-5 py-3 border-b border-border-subtle flex items-center justify-between gap-3">
			<div class="min-w-0">
				<h2 class="font-semibold truncate">{{ address }}</h2>
				<p class="text-xs text-text-tertiary">Learned from your sent mail</p>
			</div>
			<label class="flex items-center gap-2 shrink-0 cursor-pointer">
				<input
					type="checkbox"
					:checked="enabled"
					:disabled="setEnabled.isLoading.value"
					@change="onToggle"
				/>
				<span class="text-sm font-medium">Personalize AI drafts</span>
			</label>
		</header>

		<div v-if="isLoading" class="p-6 flex justify-center">
			<Icon name="lucide:loader-2" class="w-5 h-5 animate-spin text-text-tertiary" />
		</div>

		<div v-else class="px-5 py-4 space-y-3">
			<p v-if="!enabled" class="text-sm text-text-secondary">
				Turn this on to let AI reply suggestions match your greeting, sign-off and tone.
			</p>

			<template v-else>
				<div>
					<label class="text-xs font-medium text-text-tertiary" :for="`voice-rules-${mailboxId}`">
						Your writing rules
					</label>
					<textarea
						:id="`voice-rules-${mailboxId}`"
						v-model="instructionDraft"
						rows="3"
						class="input mt-1 w-full resize-y text-sm"
						placeholder="One instruction per line, for example: Never use exclamation marks"
					/>
					<div class="mt-2 flex justify-end">
						<UiButton
							size="sm"
							variant="secondary"
							:loading="saveInstructions.isLoading.value"
							@click="onSaveInstructions"
						>
							Save rules
						</UiButton>
					</div>
				</div>

				<div v-if="isRefreshing" class="flex items-center gap-2 text-sm text-text-secondary">
					<Icon name="lucide:loader-2" class="w-4 h-4 animate-spin" />
					Learning your writing voice…
				</div>

				<dl v-if="profile" class="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
					<div v-if="profile.greetings.length" class="col-span-2">
						<dt class="text-text-tertiary text-xs">Greetings</dt>
						<dd>{{ profile.greetings.join(', ') }}</dd>
					</div>
					<div v-if="profile.signOffs.length" class="col-span-2">
						<dt class="text-text-tertiary text-xs">Sign-offs</dt>
						<dd>{{ profile.signOffs.join(', ') }}</dd>
					</div>
					<div>
						<dt class="text-text-tertiary text-xs">Formality</dt>
						<dd>{{ profile.formality }}/5</dd>
					</div>
					<div>
						<dt class="text-text-tertiary text-xs">Brevity</dt>
						<dd>{{ profile.brevity }}/5</dd>
					</div>
					<div v-if="profile.languages.length">
						<dt class="text-text-tertiary text-xs">Language</dt>
						<dd>{{ profile.languages.join(', ') }}</dd>
					</div>
					<div>
						<dt class="text-text-tertiary text-xs">Emoji</dt>
						<dd>{{ profile.isEmojiUser ? 'Yes' : 'No' }}</dd>
					</div>
					<div v-if="profile.examplePhrasings.length" class="col-span-2">
						<dt class="text-text-tertiary text-xs">Example phrasings</dt>
						<dd class="italic text-text-secondary">{{ profile.examplePhrasings.join(' · ') }}</dd>
					</div>
				</dl>

				<p v-else-if="!isRefreshing" class="text-sm text-text-secondary">
					No voice learned yet. Refresh to analyze your recent sent mail.
				</p>

				<div v-if="data?.derivedAdjustments.length" class="space-y-2">
					<p class="text-xs font-medium text-text-tertiary">Learned writing rules</p>
					<div
						v-for="adjustment in data.derivedAdjustments"
						:key="adjustment.kind"
						class="flex items-center justify-between gap-3 rounded-md bg-bg-surface px-3 py-2"
					>
						<p class="text-sm text-text-secondary">{{ adjustment.directive }}</p>
						<UiButton
							variant="ghost"
							size="sm"
							class="shrink-0 text-error hover:text-error"
							:loading="removeAdjustment.isLoading.value"
							@click="onRemoveAdjustment(adjustment.kind)"
						>
							Remove
						</UiButton>
					</div>
				</div>

				<div class="flex items-center justify-between gap-3 pt-1">
					<p class="text-xs text-text-tertiary">
						<template v-if="lastComputedLabel">Updated {{ lastComputedLabel }}</template>
						<template v-else>Not yet computed</template>
					</p>
					<UiButton
						size="sm"
						variant="secondary"
						:loading="refreshNow.isLoading.value"
						:disabled="isRefreshing"
						@click="onRefresh"
					>
						Refresh now
					</UiButton>
				</div>
			</template>
		</div>
	</section>
</template>
