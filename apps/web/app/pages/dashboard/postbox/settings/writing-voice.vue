<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';

useHead({ title: 'Writing voice — Owlat' });

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
			to="/dashboard/postbox/settings"
			class="text-sm text-text-secondary hover:text-text-primary inline-flex items-center gap-1 mb-4"
		>
			<Icon name="lucide:chevron-left" class="w-4 h-4" />
			Settings
		</NuxtLink>

		<header class="mb-6">
			<h1 class="text-2xl font-semibold">Writing voice</h1>
			<p class="text-text-secondary mt-1">
				Owlat can learn how you write from your sent mail so AI reply suggestions
				sound like you. This is advisory only — nothing is ever sent automatically.
			</p>
		</header>

		<div
			v-if="!isEnabled('ai')"
			class="card p-5 text-sm text-text-secondary"
		>
			AI features are disabled for this workspace, so there is no writing voice to personalize.
		</div>

		<div v-else-if="isLoading" class="p-8 flex justify-center">
			<Icon name="lucide:loader-2" class="w-5 h-5 animate-spin text-text-tertiary" />
		</div>

		<div v-else-if="mailboxes.length === 0" class="card p-8 text-center text-text-secondary">
			No mailboxes yet. Add an account and send a few messages first.
		</div>

		<div v-else class="space-y-4">
			<PostboxVoiceProfileCard
				v-for="mb in mailboxes"
				:key="mb._id"
				:mailbox-id="(mb._id as Id<'mailboxes'>)"
				:address="mb.address"
			/>
		</div>
	</div>
</template>
