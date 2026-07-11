<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

interface Props {
	roomId: Id<'chatRooms'>;
	initialName: string;
	initialDescription?: string;
	initialVisibility: 'public' | 'private';
}

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
	{ label: 'Update channel', inlineTarget: error }
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
	if (result !== undefined) emit('saved');
};
</script>

<template>
	<ChatDialogShell title="Edit channel" @close="emit('close')">
		<div class="px-5 py-4 space-y-4">
			<div>
				<label for="edit-name" class="block text-sm font-medium text-text-secondary mb-1.5"
					>Name</label
				>
				<input
					id="edit-name"
					v-model="name"
					type="text"
					placeholder="e.g. general"
					class="input w-full"
					@keydown.enter.prevent="handleSubmit"
				/>
			</div>
			<div>
				<label for="edit-description" class="block text-sm font-medium text-text-secondary mb-1.5">
					Description <span class="text-text-tertiary font-normal">(optional)</span>
				</label>
				<input
					id="edit-description"
					v-model="description"
					type="text"
					placeholder="What is this channel about?"
					class="input w-full"
				/>
			</div>
			<div>
				<label class="block text-sm font-medium text-text-secondary mb-1.5">Visibility</label>
				<div class="flex gap-2">
					<button
						class="flex-1 px-3 py-2 rounded-lg border text-sm transition-colors"
						:class="
							visibility === 'public'
								? 'bg-brand-subtle border-brand text-brand'
								: 'bg-bg-surface border-border-subtle text-text-secondary hover:text-text-primary'
						"
						@click="visibility = 'public'"
					>
						<Icon name="lucide:hash" class="w-4 h-4 inline mr-1" />
						Public
					</button>
					<button
						class="flex-1 px-3 py-2 rounded-lg border text-sm transition-colors"
						:class="
							visibility === 'private'
								? 'bg-brand-subtle border-brand text-brand'
								: 'bg-bg-surface border-border-subtle text-text-secondary hover:text-text-primary'
						"
						@click="visibility = 'private'"
					>
						<Icon name="lucide:lock" class="w-4 h-4 inline mr-1" />
						Private
					</button>
				</div>
			</div>

			<div v-if="error" class="text-sm text-error">{{ error }}</div>
		</div>

		<div class="flex items-center justify-end gap-3 px-5 py-4 border-t border-border-subtle">
			<button class="btn btn-secondary" @click="emit('close')">Cancel</button>
			<button
				class="btn btn-primary gap-2"
				:disabled="!name.trim() || isSaving"
				@click="handleSubmit"
			>
				<UiSpinner v-if="isSaving" size="xs" tone="inverse" />
				<Icon v-else name="lucide:check" class="w-4 h-4" />
				Save
			</button>
		</div>
	</ChatDialogShell>
</template>
