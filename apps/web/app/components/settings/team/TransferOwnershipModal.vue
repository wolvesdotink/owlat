<script setup lang="ts">
import type { OrganizationMember } from '~/composables/useOrganization';

/**
 * Transfer ownership (owner only): promotes `member` to owner and demotes the
 * current owner to admin — the only succession path. The operator types
 * TRANSFER before the button arms; `confirm` fires only once it matches, and
 * the typed phrase is dropped whenever the modal closes so the next open is
 * never one click away. The page owns the transfer and its inflight flag.
 */
const props = defineProps<{
	member: OrganizationMember | null;
	busy: boolean;
}>();

const emit = defineEmits<{ close: []; confirm: [] }>();

const { t } = useI18n();

const PHRASE = 'TRANSFER';
const confirmText = ref('');
const canConfirm = computed(() => confirmText.value === PHRASE);

watch(
	() => props.member,
	(member) => {
		if (!member) confirmText.value = '';
	}
);

function confirm() {
	if (!canConfirm.value) return;
	emit('confirm');
}
</script>

<template>
	<UiModal
		:open="!!member"
		size="lg"
		:closable="!busy"
		:persistent="busy"
		@update:open="(v: boolean) => !v && emit('close')"
	>
		<div class="flex items-center gap-3 mb-6">
			<UiIconBox icon="lucide:crown" size="sm" variant="brand" rounded="lg" />
			<div>
				<h2 class="text-lg font-semibold text-text-primary">
					{{ t('dashboard.admin.team.transferModal.title') }}
				</h2>
				<p class="text-sm text-text-secondary">
					{{ t('dashboard.admin.team.transferModal.subtitle') }}
				</p>
			</div>
		</div>

		<div class="p-4 rounded-xl bg-bg-surface border border-border-subtle mb-6">
			<I18nT
				keypath="dashboard.admin.team.transferModal.body"
				tag="p"
				class="text-sm text-text-secondary"
				scope="global"
			>
				<template #member>
					<span v-if="member" class="font-medium text-text-primary">{{
						member.user.name || member.user.email
					}}</span>
				</template>
				<template #ownerRole>
					<strong class="text-text-primary">{{
						t('dashboard.admin.team.transferModal.ownerRole')
					}}</strong>
				</template>
				<template #adminRole>
					<strong>{{ t('dashboard.admin.team.transferModal.adminRole') }}</strong>
				</template>
			</I18nT>
		</div>

		<div>
			<label class="label" for="confirm-transfer-ownership">
				<I18nT keypath="dashboard.admin.team.transferModal.typeToConfirm" scope="global">
					<template #phrase
						><strong class="text-text-primary">{{ PHRASE }}</strong></template
					>
				</I18nT>
			</label>
			<input
				id="confirm-transfer-ownership"
				v-model="confirmText"
				type="text"
				class="input"
				:placeholder="PHRASE"
				autocomplete="off"
				:disabled="busy"
			/>
		</div>

		<template #footer>
			<UiButton variant="secondary" :disabled="busy" @click="emit('close')">
				{{ t('common.cancel') }}
			</UiButton>
			<UiButton :loading="busy" :disabled="!canConfirm" @click="confirm">
				<template #iconLeft>
					<Icon v-if="!busy" name="lucide:crown" class="w-4 h-4" />
				</template>
				{{
					busy
						? t('dashboard.admin.team.transferModal.transferring')
						: t('dashboard.admin.team.transferModal.confirm')
				}}
			</UiButton>
		</template>
	</UiModal>
</template>
