<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';
import { SpinnerIcon } from '@owlat/ui/icons/SpinnerIcon';

const { t } = useI18n();

useHead({ title: () => t('dashboard.preferences.writingVoice.pageTitle') });

definePageMeta({
	layout: 'preferences',
	middleware: 'auth',
	requiresAnyFeature: ['postbox', 'mail.external'],
});

const { mailboxes, isLoading, error, refetch } = usePostboxMailbox();
const { isEnabled } = useFeatureFlag();
</script>

<template>
	<div>
		<header class="mb-6">
			<p class="text-text-secondary">
				{{ t('dashboard.preferences.writingVoice.intro') }}
			</p>
		</header>

		<div v-if="!isEnabled('ai')" class="card p-5 text-sm text-text-secondary">
			{{ t('dashboard.preferences.writingVoice.aiDisabled') }}
		</div>

		<div v-else-if="isLoading" class="p-8 flex justify-center">
			<SpinnerIcon class="w-5 h-5 text-text-tertiary" />
		</div>

		<!-- A failed read is not an empty list. -->
		<UiQueryBoundary v-else-if="error" :error="error" @retry="refetch" />

		<div v-else-if="mailboxes.length === 0" class="card p-8 text-center text-text-secondary">
			{{ t('dashboard.preferences.writingVoice.noMailboxes') }}
		</div>

		<!-- Each mailbox's voice card and its opt-out stay together as one group,
		     spaced apart from the next mailbox, so the opt-out reads as part of
		     the mailbox above it. -->
		<div v-else class="space-y-6">
			<div v-for="mb in mailboxes" :key="mb._id" class="space-y-2">
				<PostboxVoiceProfileCard :mailbox-id="mb._id as Id<'mailboxes'>" :address="mb.address" />
				<!-- This mailbox's opt-out from hosted decision providers.
				     Admins manage every mailbox's on the admin mailbox list in Preferences. -->
				<SettingsHostedDecisionExclusion
					:target="{ kind: 'mailbox', mailboxId: mb._id as Id<'mailboxes'> }"
					:is-excluded="mb.isExcludedFromHostedDecisions === true"
					:address="mb.address"
				/>
			</div>
		</div>
	</div>
</template>
