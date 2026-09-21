<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

interface Props {
	roomId: Id<'chatRooms'>;
	initialName: string;
	initialDescription?: string;
	initialVisibility: 'public' | 'private';
}

const { t } = useI18n();

const props = defineProps<Props>();
const emit = defineEmits<{
	close: [];
	saved: [];
}>();

const name = ref(props.initialName);
const description = ref(props.initialDescription ?? '');
const visibility = ref<'public' | 'private'>(props.initialVisibility);

// Drive the update through useBackendOperation directly (not the useChatActions
// wrapper) so invalid_input / already_exists failures surface inline on `error`
// and the dialog only closes when the edit actually succeeded.
const error = ref<string | null>(null);
const { run: updateChannel, isLoading: isSaving } = useBackendOperation(
	api.chat.rooms.updateChannel,
	{
		label: () => t('components.chat.chatEditChannelDialog.operations.updateChannel'),
		inlineTarget: error,
	}
);

const handleSubmit = async () => {
	if (!name.value.trim()) return;
	// run() returns undefined ONLY on failure and the mutation's value (null) on
	// success, so it is the reliable success signal. Gating on `!error.value`
	// would falsely emit 'saved' for every failure category that surfaces as a
	// toast/redirect (forbidden, conflict, invalid_state, rate_limited, unknown,
	// network) — those never touch the inline `error` ref. invalid_input /
	// already_exists still render inline via inlineTarget.
	const result = await updateChannel({
		roomId: props.roomId,
		name: name.value,
		description: description.value,
		visibility: visibility.value,
	});
	if (result.ok) emit('saved');
};
</script>

<template>
	<ChatDialogShell :title="t('components.chat.chatEditChannelDialog.title')" @close="emit('close')">
		<div class="px-5 py-4 space-y-4">
			<div>
				<label for="edit-name" class="block text-sm font-medium text-text-secondary mb-1.5">{{
					t('common.name')
				}}</label>
				<input
					id="edit-name"
					v-model="name"
					type="text"
					:placeholder="t('components.chat.chatEditChannelDialog.namePlaceholder')"
					class="input w-full"
					@keydown.enter.prevent="handleSubmit"
				/>
			</div>
			<div>
				<I18nT
					keypath="components.chat.chatEditChannelDialog.descriptionLabel"
					tag="label"
					scope="global"
					for="edit-description"
					class="block text-sm font-medium text-text-secondary mb-1.5"
				>
					<template #optional>
						<span class="text-text-tertiary font-normal">{{
							t('components.chat.chatEditChannelDialog.optional')
						}}</span>
					</template>
				</I18nT>
				<input
					id="edit-description"
					v-model="description"
					type="text"
					:placeholder="t('components.chat.chatEditChannelDialog.descriptionPlaceholder')"
					class="input w-full"
				/>
			</div>
			<div>
				<label class="block text-sm font-medium text-text-secondary mb-1.5">{{
					t('components.chat.chatEditChannelDialog.visibilityLabel')
				}}</label>
				<div class="flex gap-2">
					<UiButton
						variant="outline"
						size="sm"
						class="flex-1"
						:class="visibility === 'public' ? 'bg-brand-subtle text-brand' : ''"
						@click="visibility = 'public'"
					>
						<template #iconLeft>
							<Icon name="lucide:hash" class="w-4 h-4" />
						</template>
						{{ t('components.chat.chatEditChannelDialog.public') }}
					</UiButton>
					<UiButton
						variant="outline"
						size="sm"
						class="flex-1"
						:class="visibility === 'private' ? 'bg-brand-subtle text-brand' : ''"
						@click="visibility = 'private'"
					>
						<template #iconLeft>
							<Icon name="lucide:lock" class="w-4 h-4" />
						</template>
						{{ t('components.chat.chatEditChannelDialog.private') }}
					</UiButton>
				</div>
			</div>

			<div v-if="error" class="text-sm text-error">{{ error }}</div>
		</div>

		<div class="flex items-center justify-end gap-3 px-5 py-4 border-t border-border-subtle">
			<UiButton variant="secondary" @click="emit('close')">{{ t('common.cancel') }}</UiButton>
			<UiButton class="gap-2" :disabled="!name.trim() || isSaving" @click="handleSubmit">
				<UiSpinner v-if="isSaving" size="xs" tone="inverse" />
				<Icon v-else name="lucide:check" class="w-4 h-4" />
				{{ t('common.save') }}
			</UiButton>
		</div>
	</ChatDialogShell>
</template>
