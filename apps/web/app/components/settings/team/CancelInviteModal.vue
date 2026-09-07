<script setup lang="ts">
import type { OrganizationInvitation } from '~/composables/useOrganization';

/**
 * "Cancel this invitation?" — the confirmation in front of revoking a pending
 * invite. Presentational: the page owns the revocation and its inflight flag.
 * Open while `invitation` is set.
 */
defineProps<{
	invitation: OrganizationInvitation | null;
	busy: boolean;
}>();

const emit = defineEmits<{ close: []; confirm: [] }>();

const { t } = useI18n();
</script>

<template>
	<UiModal
		:open="!!invitation"
		:title="t('dashboard.admin.team.cancelInviteModal.title')"
		@update:open="(v: boolean) => !v && emit('close')"
	>
		<I18nT
			keypath="dashboard.admin.team.cancelInviteModal.body"
			tag="p"
			class="text-text-secondary"
			scope="global"
		>
			<template #email>
				<span v-if="invitation" class="font-medium text-text-primary">{{ invitation.email }}</span>
			</template>
		</I18nT>

		<template #footer>
			<UiButton variant="secondary" :disabled="busy" @click="emit('close')">
				{{ t('dashboard.admin.team.cancelInviteModal.keep') }}
			</UiButton>
			<UiButton variant="danger" :loading="busy" @click="emit('confirm')">
				<template #iconLeft>
					<Icon v-if="!busy" name="lucide:x" class="w-4 h-4" />
				</template>
				{{
					busy
						? t('dashboard.admin.team.cancelInviteModal.cancelling')
						: t('dashboard.admin.team.cancelInviteModal.confirm')
				}}
			</UiButton>
		</template>
	</UiModal>
</template>
