<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

const { t, locale } = useI18n();

const props = defineProps<{
	mailboxId: Id<'mailboxes'>;
	address: string;
}>();

const { data, isLoading } = useConvexQuery(api.mail.ai.voiceProfile.get, () => ({
	mailboxId: props.mailboxId,
}));

const setEnabled = useBackendOperation(api.mail.ai.voiceProfile.setEnabled, {
	label: () => t('components.postbox.postboxVoiceProfileCard.updateOperation'),
});
const refreshNow = useBackendOperation(api.mail.ai.voiceProfile.requestRefresh, {
	label: () => t('components.postbox.postboxVoiceProfileCard.refreshOperation'),
});
const saveInstructions = useBackendOperation(api.mail.ai.voiceProfile.setStandingInstructions, {
	label: () => t('components.postbox.postboxVoiceProfileCard.saveInstructionsOperation'),
});
const removeAdjustment = useBackendOperation(api.mail.ai.voiceProfile.removeDerivedAdjustment, {
	label: () => t('components.postbox.postboxVoiceProfileCard.removeAdjustmentOperation'),
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
	return ts ? new Date(ts).toLocaleString(locale.value) : null;
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
				<p class="text-xs text-text-tertiary">
					{{ t('components.postbox.postboxVoiceProfileCard.learnedFrom') }}
				</p>
			</div>
			<label class="flex items-center gap-2 shrink-0 cursor-pointer">
				<input
					type="checkbox"
					:checked="enabled"
					:disabled="setEnabled.isLoading.value"
					@change="onToggle"
				/>
				<span class="text-sm font-medium">
					{{ t('components.postbox.postboxVoiceProfileCard.personalize') }}
				</span>
			</label>
		</header>

		<div v-if="isLoading" class="p-6 flex justify-center">
			<Icon name="lucide:loader-2" class="w-5 h-5 animate-spin text-text-tertiary" />
		</div>

		<div v-else class="px-5 py-4 space-y-3">
			<p v-if="!enabled" class="text-sm text-text-secondary">
				{{ t('components.postbox.postboxVoiceProfileCard.disabledHint') }}
			</p>

			<template v-else>
				<div>
					<label class="text-xs font-medium text-text-tertiary" :for="`voice-rules-${mailboxId}`">
						{{ t('components.postbox.postboxVoiceProfileCard.rulesLabel') }}
					</label>
					<textarea
						:id="`voice-rules-${mailboxId}`"
						v-model="instructionDraft"
						rows="3"
						class="input mt-1 w-full resize-y text-sm"
						:placeholder="t('components.postbox.postboxVoiceProfileCard.rulesPlaceholder')"
					/>
					<div class="mt-2 flex justify-end">
						<UiButton
							size="sm"
							variant="secondary"
							:loading="saveInstructions.isLoading.value"
							@click="onSaveInstructions"
						>
							{{ t('components.postbox.postboxVoiceProfileCard.saveRules') }}
						</UiButton>
					</div>
				</div>

				<div v-if="isRefreshing" class="flex items-center gap-2 text-sm text-text-secondary">
					<Icon name="lucide:loader-2" class="w-4 h-4 animate-spin" />
					{{ t('components.postbox.postboxVoiceProfileCard.learning') }}
				</div>

				<dl v-if="profile" class="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
					<div v-if="profile.greetings.length" class="col-span-2">
						<dt class="text-text-tertiary text-xs">
							{{ t('components.postbox.postboxVoiceProfileCard.greetings') }}
						</dt>
						<dd>{{ profile.greetings.join(', ') }}</dd>
					</div>
					<div v-if="profile.signOffs.length" class="col-span-2">
						<dt class="text-text-tertiary text-xs">
							{{ t('components.postbox.postboxVoiceProfileCard.signOffs') }}
						</dt>
						<dd>{{ profile.signOffs.join(', ') }}</dd>
					</div>
					<div>
						<dt class="text-text-tertiary text-xs">
							{{ t('components.postbox.postboxVoiceProfileCard.formality') }}
						</dt>
						<dd>
							{{
								t('components.postbox.postboxVoiceProfileCard.outOfFive', {
									value: profile.formality,
								})
							}}
						</dd>
					</div>
					<div>
						<dt class="text-text-tertiary text-xs">
							{{ t('components.postbox.postboxVoiceProfileCard.brevity') }}
						</dt>
						<dd>
							{{
								t('components.postbox.postboxVoiceProfileCard.outOfFive', {
									value: profile.brevity,
								})
							}}
						</dd>
					</div>
					<div v-if="profile.languages.length">
						<dt class="text-text-tertiary text-xs">
							{{ t('components.postbox.postboxVoiceProfileCard.language') }}
						</dt>
						<dd>{{ profile.languages.join(', ') }}</dd>
					</div>
					<div>
						<dt class="text-text-tertiary text-xs">
							{{ t('components.postbox.postboxVoiceProfileCard.emoji') }}
						</dt>
						<dd>{{ profile.isEmojiUser ? t('common.yes') : t('common.no') }}</dd>
					</div>
					<div v-if="profile.examplePhrasings.length" class="col-span-2">
						<dt class="text-text-tertiary text-xs">
							{{ t('components.postbox.postboxVoiceProfileCard.examplePhrasings') }}
						</dt>
						<dd class="italic text-text-secondary">{{ profile.examplePhrasings.join(' · ') }}</dd>
					</div>
				</dl>

				<p v-else-if="!isRefreshing" class="text-sm text-text-secondary">
					{{ t('components.postbox.postboxVoiceProfileCard.noVoiceYet') }}
				</p>

				<div v-if="data?.derivedAdjustments.length" class="space-y-2">
					<p class="text-xs font-medium text-text-tertiary">
						{{ t('components.postbox.postboxVoiceProfileCard.learnedRules') }}
					</p>
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
							{{ t('common.remove') }}
						</UiButton>
					</div>
				</div>

				<div class="flex items-center justify-between gap-3 pt-1">
					<p class="text-xs text-text-tertiary">
						<template v-if="lastComputedLabel">{{
							t('components.postbox.postboxVoiceProfileCard.updated', {
								when: lastComputedLabel,
							})
						}}</template>
						<template v-else>{{
							t('components.postbox.postboxVoiceProfileCard.notComputed')
						}}</template>
					</p>
					<UiButton
						size="sm"
						variant="secondary"
						:loading="refreshNow.isLoading.value"
						:disabled="isRefreshing"
						@click="onRefresh"
					>
						{{ t('components.postbox.postboxVoiceProfileCard.refreshNow') }}
					</UiButton>
				</div>
			</template>
		</div>
	</section>
</template>
