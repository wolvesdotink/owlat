<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';

const { t } = useI18n();

useHead({ title: () => t('dashboard.preferences.writingVoice.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	requiresAnyFeature: ['postbox', 'mail.external'],
});

const { mailboxes, isLoading } = usePostboxMailbox();
const { isEnabled } = useFeatureFlag();
</script>

<template>
	<div class="p-6 lg:p-8 max-w-3xl">
		<NuxtLink
			to="/dashboard/preferences"
			class="text-sm text-text-secondary hover:text-text-primary inline-flex items-center gap-1 mb-4"
		>
			<Icon name="lucide:chevron-left" class="w-4 h-4" />
			{{ t('common.settings') }}
		</NuxtLink>

		<header class="mb-6">
			<h1 class="text-2xl font-medium tracking-[-0.02em]">
				{{ t('dashboard.preferences.writingVoice.title') }}
			</h1>
			<p class="text-text-secondary mt-1">
				{{ t('dashboard.preferences.writingVoice.intro') }}
			</p>
		</header>

		<div v-if="!isEnabled('ai')" class="card p-5 text-sm text-text-secondary">
			{{ t('dashboard.preferences.writingVoice.aiDisabled') }}
		</div>

		<div v-else-if="isLoading" class="p-8 flex justify-center">
			<Icon name="lucide:loader-2" class="w-5 h-5 animate-spin text-text-tertiary" />
		</div>

		<div v-else-if="mailboxes.length === 0" class="card p-8 text-center text-text-secondary">
			{{ t('dashboard.preferences.writingVoice.noMailboxes') }}
		</div>

		<div v-else class="space-y-4">
			<PostboxVoiceProfileCard
				v-for="mb in mailboxes"
				:key="mb._id"
				:mailbox-id="mb._id as Id<'mailboxes'>"
				:address="mb.address"
			/>
		</div>
	</div>
</template>
