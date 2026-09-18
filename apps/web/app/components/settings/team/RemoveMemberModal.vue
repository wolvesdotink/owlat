<script setup lang="ts">
import type { OrganizationMember } from '~/composables/useOrganization';

/**
 * "Remove this member?" — the confirmation in front of the roster's remove
 * action. Presentational: the page owns the removal and its inflight flag,
 * this only asks. Open while `member` is set.
 */
defineProps<{
	member: OrganizationMember | null;
	busy: boolean;
}>();

const emit = defineEmits<{ close: []; confirm: [] }>();

const { t } = useI18n();
</script>

<template>
	<UiModal
		:open="!!member"
		:title="t('dashboard.admin.team.removeModal.title')"
		@update:open="(v: boolean) => !v && emit('close')"
	>
		<I18nT
			keypath="dashboard.admin.team.removeModal.body"
			tag="p"
			class="text-text-secondary"
			scope="global"
		>
			<template #member>
				<span v-if="member" class="font-medium text-text-primary">
					{{ member.user.name || member.user.email }}
				</span>
			</template>
		</I18nT>

		<template #footer>
			<UiButton variant="secondary" :disabled="busy" @click="emit('close')">
				{{ t('common.cancel') }}
			</UiButton>
			<UiButton variant="danger" :loading="busy" @click="emit('confirm')">
				<template #iconLeft>
					<Icon v-if="!busy" name="lucide:trash-2" class="w-4 h-4" />
				</template>
				{{
					busy
						? t('dashboard.admin.team.removeModal.removing')
						: t('dashboard.admin.team.removeModal.confirm')
				}}
			</UiButton>
		</template>
	</UiModal>
</template>
