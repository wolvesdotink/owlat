<script setup lang="ts">
import type { OrganizationInvitation } from '~/composables/useOrganization';
import { useLocalized } from '~/composables/useLocalized';
import { roleDefinition } from '~/utils/teamRoles';
import { ClockIcon, CloseIcon, LinkIcon, MailIcon, PaperPlaneIcon } from '@coolicons/vue';

/**
 * Pending invites with their expiry and the copy-link, resend and revoke
 * actions. Presentational: the page owns the writes and the resend flag.
 */
defineProps<{
	invitations: OrganizationInvitation[];
	canManageMembers: boolean;
	/** The invite whose email is being re-sent, if any. */
	resendingId: string | null;
}>();

const emit = defineEmits<{
	copyLink: [invitationId: string];
	resend: [invite: OrganizationInvitation];
	revoke: [invite: OrganizationInvitation];
}>();

const { t } = useI18n();
const localized = useLocalized();

const isInviteExpired = (invite: OrganizationInvitation) =>
	new Date(invite.expiresAt).getTime() < Date.now();

// Format relative time for invite expiry
const formatExpiryTime = (expiresAt: Date) => {
	const now = Date.now();
	const diff = new Date(expiresAt).getTime() - now;

	if (diff < 0) return t('dashboard.admin.team.invites.expired');

	const days = Math.floor(diff / (1000 * 60 * 60 * 24));
	const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));

	if (days > 0) return t('dashboard.admin.team.invites.expiresInDaysHours', { days, hours });
	if (hours > 0) return t('dashboard.admin.team.invites.expiresInHours', { hours });
	return t('dashboard.admin.team.invites.expiresSoon');
};
</script>

<template>
	<UiCard padding="none" overflow="hidden">
		<template #header>
			<div class="flex items-center gap-3">
				<UiIconBox :icon="MailIcon" size="sm" variant="surface" rounded="lg" />
				<div>
					<h2 class="text-lg font-semibold text-text-primary">
						{{ t('dashboard.admin.team.invites.title') }}
					</h2>
					<p class="text-sm text-text-secondary">
						{{
							t(
								'dashboard.admin.team.invites.count',
								{ count: invitations.length },
								invitations.length
							)
						}}
					</p>
				</div>
			</div>
		</template>

		<div class="divide-y divide-border-subtle">
			<div
				v-for="invite in invitations"
				:key="invite.id"
				class="px-6 py-4 flex items-center justify-between"
			>
				<div class="flex items-center gap-4">
					<!-- Email Icon -->
					<div class="w-10 h-10 rounded-full bg-bg-surface flex items-center justify-center">
						<MailIcon class="w-5 h-5 text-text-tertiary" />
					</div>

					<!-- Email and Status -->
					<div>
						<div class="flex items-center gap-2">
							<p class="font-medium text-text-primary">{{ invite.email }}</p>
							<!-- Role Badge -->
							<span
								:class="[
									'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border',
									roleDefinition(invite.role).badgeToneClass,
								]"
							>
								<component :is="roleDefinition(invite.role).icon" class="w-3 h-3" />
								{{ localized(roleDefinition(invite.role).label) }}
							</span>
						</div>
						<div class="flex items-center gap-2 text-sm text-text-tertiary">
							<ClockIcon class="w-3 h-3" />
							<span>{{ formatExpiryTime(invite.expiresAt) }}</span>
						</div>
					</div>
				</div>

				<!-- Row actions: copy link / resend / revoke -->
				<div v-if="canManageMembers" class="flex items-center gap-1">
					<UiTooltip :text="t('dashboard.admin.team.invites.copyLink')">
						<UiButton
							variant="ghost"
							size="sm"
							:aria-label="t('dashboard.admin.team.invites.copyLink')"
							@click="emit('copyLink', invite.id)"
						>
							<LinkIcon class="w-4 h-4 text-text-secondary" />
						</UiButton>
					</UiTooltip>
					<!-- An expired invite's obvious next step is a fresh email, so it
					     gets a labelled button instead of a bare icon. -->
					<UiTooltip
						v-if="isInviteExpired(invite)"
						:text="t('dashboard.admin.team.invites.resend')"
					>
						<UiButton
							variant="outline"
							size="sm"
							:loading="resendingId === invite.id"
							:disabled="resendingId === invite.id"
							data-testid="invite-resend-labelled"
							@click="emit('resend', invite)"
						>
							<PaperPlaneIcon v-if="resendingId !== invite.id" class="w-4 h-4 mr-2" />
							{{ t('dashboard.admin.team.invites.resendShort') }}
						</UiButton>
					</UiTooltip>
					<UiTooltip v-else :text="t('dashboard.admin.team.invites.resend')">
						<UiButton
							variant="ghost"
							size="sm"
							:aria-label="t('dashboard.admin.team.invites.resend')"
							:loading="resendingId === invite.id"
							:disabled="resendingId === invite.id"
							@click="emit('resend', invite)"
						>
							<PaperPlaneIcon
								v-if="resendingId !== invite.id"
								class="w-4 h-4 text-text-secondary"
							/>
						</UiButton>
					</UiTooltip>
					<UiTooltip :text="t('dashboard.admin.team.invites.revoke')">
						<UiButton
							variant="ghost"
							size="sm"
							:aria-label="t('dashboard.admin.team.invites.revoke')"
							@click="emit('revoke', invite)"
						>
							<CloseIcon class="w-4 h-4 text-text-secondary hover:text-error" />
						</UiButton>
					</UiTooltip>
				</div>
			</div>
		</div>
	</UiCard>
</template>
