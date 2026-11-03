<script setup lang="ts">
import { TrashIcon } from '@coolicons/vue';

defineProps<{
	/**
	 * Owners trigger the org-deletion walker; members only erase their personal
	 * data, so each is told what actually goes.
	 */
	isOwner: boolean;
}>();

const emit = defineEmits<{ request: [] }>();

const { t } = useI18n();
</script>

<template>
	<div class="card p-0 overflow-hidden border-error/20">
		<div class="px-6 py-4 border-b border-error/10 bg-error/5">
			<div class="flex items-center gap-3">
				<UiIconBox :icon="TrashIcon" size="sm" variant="error" rounded="lg" />
				<div>
					<h2 class="text-lg font-semibold text-error">
						{{ t('dashboard.preferences.account.deleteAccountTitle') }}
					</h2>
					<p class="text-sm text-error/80">
						{{ t('dashboard.preferences.account.deleteAccountSubtitle') }}
					</p>
				</div>
			</div>
		</div>

		<div class="p-6">
			<div class="mb-6">
				<p class="text-text-secondary text-sm mb-4">
					{{ t('dashboard.preferences.account.deleteAccountBody') }}
				</p>
				<p class="text-text-secondary text-sm">
					<strong class="text-text-primary">
						{{ t('dashboard.preferences.account.whatWillBeDeleted') }}
					</strong>
				</p>
				<!-- Owners trigger the org-deletion walker, so their team's data goes too. -->
				<ul v-if="isOwner" class="list-disc list-inside text-sm text-text-tertiary mt-2 space-y-1">
					<li>{{ t('dashboard.preferences.account.deletedItems.profile') }}</li>
					<li>{{ t('dashboard.preferences.account.deletedItems.ownedTeams') }}</li>
					<li>{{ t('dashboard.preferences.account.deletedItems.contacts') }}</li>
					<li>{{ t('dashboard.preferences.account.deletedItems.automations') }}</li>
					<li>{{ t('dashboard.preferences.account.deletedItems.apiKeys') }}</li>
					<li>{{ t('dashboard.preferences.account.deletedItems.analytics') }}</li>
				</ul>
				<!--
					Members are routed to member-erasure, which removes only their
					personal data; org-owned records (contacts, campaigns, API keys,
					webhooks, analytics) belong to the team and are not deleted.
				-->
				<ul v-else class="list-disc list-inside text-sm text-text-tertiary mt-2 space-y-1">
					<li>{{ t('dashboard.preferences.account.deletedItems.profile') }}</li>
					<li>{{ t('dashboard.preferences.account.deletedItems.personalMailbox') }}</li>
					<li>{{ t('dashboard.preferences.account.deletedItems.externalAccounts') }}</li>
					<li>{{ t('dashboard.preferences.account.deletedItems.chatMemberships') }}</li>
				</ul>
				<p v-if="!isOwner" class="text-xs text-text-tertiary mt-3">
					{{ t('dashboard.preferences.account.memberDataNote') }}
				</p>
			</div>

			<UiButton
				class="gap-2 bg-error/10 text-error hover:bg-error/20 border border-error/20"
				@click="emit('request')"
			>
				<TrashIcon class="w-4 h-4" />
				{{ t('dashboard.preferences.account.requestDeletionAction') }}
			</UiButton>
		</div>
	</div>
</template>
