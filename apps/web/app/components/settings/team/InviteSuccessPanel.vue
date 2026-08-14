<script setup lang="ts">
/** A sent invitation, as the invite modal's success panel needs it. */
export interface InviteSuccess {
	email: string;
	acceptUrl: string;
	mailboxAddress?: string;
	/** The reserved mailbox's domain is still verifying — it activates on verify. */
	mailboxAwaitingDomain?: boolean;
}

/**
 * Success state of the invite modal: surface the copyable accept link. This
 * link works even when outbound email delivery isn't configured yet, so it is
 * the honest path in — the "we emailed them" line only appears when a transport
 * actually exists.
 */
defineProps<{
	success: InviteSuccess;
	/** An outbound transport is configured, so the invite really was emailed. */
	emailConfigured?: boolean;
}>();

const { t } = useI18n();
const { copyLinkText } = useInviteLinks();
</script>

<template>
	<div class="space-y-4">
		<div class="flex items-start gap-3">
			<UiIconBox icon="lucide:check" size="sm" variant="brand" rounded="lg" />
			<div>
				<p class="font-medium text-text-primary">
					{{ t('components.settings.team.inviteModal.invitationReady') }}
				</p>
				<p v-if="emailConfigured" class="text-sm text-text-secondary">
					{{ t('components.settings.team.inviteModal.emailedInvitee', { email: success.email }) }}
				</p>
				<p v-else class="text-sm text-text-secondary">
					{{ t('components.settings.team.inviteModal.shareAcceptLink', { email: success.email }) }}
				</p>
			</div>
		</div>

		<I18nT
			v-if="success.mailboxAddress && success.mailboxAwaitingDomain"
			keypath="components.settings.team.inviteModal.successMailboxReserved"
			tag="p"
			scope="global"
			class="text-sm text-text-secondary"
		>
			<template #address>
				<code>{{ success.mailboxAddress }}</code>
			</template>
		</I18nT>
		<I18nT
			v-else-if="success.mailboxAddress"
			keypath="components.settings.team.inviteModal.successMailboxPending"
			tag="p"
			scope="global"
			class="text-sm text-text-secondary"
		>
			<template #address>
				<code>{{ success.mailboxAddress }}</code>
			</template>
		</I18nT>

		<div>
			<label class="text-sm font-medium block mb-1">{{
				t('components.settings.team.inviteModal.acceptLinkLabel')
			}}</label>
			<div class="flex items-center gap-2">
				<input
					:value="success.acceptUrl"
					readonly
					class="input flex-1 font-mono text-xs"
					@focus="($event.target as HTMLInputElement).select()"
				/>
				<UiButton variant="secondary" @click="copyLinkText(success.acceptUrl)">
					<template #iconLeft>
						<Icon name="lucide:copy" class="w-4 h-4" />
					</template>
					{{ t('common.copy') }}
				</UiButton>
			</div>
			<p class="text-xs text-text-tertiary mt-1">
				{{ t('components.settings.team.inviteModal.acceptLinkHint') }}
			</p>
		</div>
	</div>
</template>
