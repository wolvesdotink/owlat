<script setup lang="ts">
/**
 * Delete the workspace (owner only, Danger Zone). The operator types DELETE
 * before the button arms; `confirm` fires only once it matches, and the typed
 * phrase is dropped whenever the modal closes so the next open is never one
 * click away. The page owns the deletion, the sign-out that follows it and the
 * inflight flag.
 */
const props = defineProps<{
	open: boolean;
	workspaceName?: string;
	busy: boolean;
}>();

const emit = defineEmits<{ close: []; confirm: [] }>();

const { t } = useI18n();

const PHRASE = 'DELETE';
const confirmText = ref('');
const canConfirm = computed(() => confirmText.value === PHRASE);

watch(
	() => props.open,
	(open) => {
		if (!open) confirmText.value = '';
	}
);

function confirm() {
	if (!canConfirm.value) return;
	emit('confirm');
}
</script>

<template>
	<UiModal
		:open="open"
		size="lg"
		:closable="!busy"
		:persistent="busy"
		@update:open="(v: boolean) => !v && emit('close')"
	>
		<div class="flex items-center gap-3 mb-6">
			<UiIconBox icon="lucide:alert-triangle" size="sm" variant="error" rounded="lg" />
			<div>
				<h2 class="text-lg font-semibold text-text-primary">
					{{ t('dashboard.admin.team.deleteModal.title') }}
				</h2>
				<p class="text-sm text-text-secondary">
					{{ t('dashboard.admin.team.deleteModal.subtitle') }}
				</p>
			</div>
		</div>

		<div class="p-4 rounded-xl bg-error/5 border border-error/20 mb-6">
			<I18nT
				keypath="dashboard.admin.team.deleteModal.warning"
				tag="p"
				class="text-sm text-error"
				scope="global"
			>
				<template #label>
					<strong>{{ t('dashboard.admin.team.deleteModal.warningLabel') }}</strong>
				</template>
				<template #workspace>
					<span v-if="workspaceName" class="font-medium">{{ workspaceName }}</span>
				</template>
			</I18nT>
		</div>

		<div>
			<label class="label" for="confirm-delete-org">
				<I18nT keypath="dashboard.admin.team.deleteModal.typeToConfirm" scope="global">
					<template #phrase
						><strong class="text-error">{{ PHRASE }}</strong></template
					>
				</I18nT>
			</label>
			<input
				id="confirm-delete-org"
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
			<UiButton variant="danger" :loading="busy" :disabled="!canConfirm" @click="confirm">
				<template #iconLeft>
					<Icon v-if="!busy" name="lucide:trash-2" class="w-4 h-4" />
				</template>
				{{
					busy
						? t('dashboard.admin.team.deleteModal.deleting')
						: t('dashboard.admin.team.deleteModal.confirm')
				}}
			</UiButton>
		</template>
	</UiModal>
</template>
