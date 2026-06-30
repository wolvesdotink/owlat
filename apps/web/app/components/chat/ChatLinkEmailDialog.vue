<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

interface Props {
	roomId: Id<'chatRooms'>;
}

const props = defineProps<Props>();
const emit = defineEmits<{ close: [] }>();

const { data: threadsData, isLoading } = useConvexQuery(
	api.inbox.queries.listThreads,
	() => ({ limit: 100 }),
);

const search = ref('');

const threads = computed(() => {
	const list = threadsData.value?.threads ?? [];
	const q = search.value.trim().toLowerCase();
	if (!q) return list;
	return list.filter(
		(t) =>
			t.subject.toLowerCase().includes(q) ||
			(t.contactIdentifier ?? '').toLowerCase().includes(q),
	);
});

const { linkChannelToInboxThread, unlinkChannel } = useChatActions();
const isSubmitting = ref(false);

const linkAndClose = async (threadId: Id<'conversationThreads'>) => {
	isSubmitting.value = true;
	try {
		// useBackendOperation toasts failure and returns undefined; close
		// only on a real success result.
		const result = await linkChannelToInboxThread(props.roomId, threadId);
		if (result !== undefined) emit('close');
	} finally {
		isSubmitting.value = false;
	}
};

const unlinkAndClose = async () => {
	isSubmitting.value = true;
	try {
		const result = await unlinkChannel(props.roomId);
		if (result !== undefined) emit('close');
	} finally {
		isSubmitting.value = false;
	}
};

const formatTime = (timestamp: number) => {
	return new Date(timestamp).toLocaleDateString(undefined, {
		month: 'short',
		day: 'numeric',
	});
};
</script>

<template>
	<ChatDialogShell title="Link an email thread" size="lg" @close="emit('close')">

				<div class="px-5 py-3 border-b border-border-subtle">
					<input
						v-model="search"
						type="text"
						placeholder="Search inbox threads…"
						class="input w-full"
					/>
				</div>

				<div class="flex-1 overflow-y-auto p-2">
					<div v-if="isLoading" class="flex items-center justify-center py-8">
						<div class="w-6 h-6 border-2 border-brand border-t-transparent rounded-full animate-spin" />
					</div>
					<div v-else-if="threads.length === 0" class="text-center py-8 text-text-tertiary text-sm">
						No inbox threads found.
					</div>
					<div v-else class="space-y-1">
						<button
							v-for="thread in threads"
							:key="thread._id"
							class="w-full text-left flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-bg-surface transition-colors"
							@click="linkAndClose(thread._id)"
						>
							<Icon name="lucide:mail" class="w-4 h-4 text-text-tertiary flex-shrink-0" />
							<div class="flex-1 min-w-0">
								<div class="text-sm font-medium text-text-primary truncate">
									{{ thread.subject }}
								</div>
								<div class="text-xs text-text-tertiary truncate">
									{{ thread.contactIdentifier }} · {{ formatTime(thread.lastMessageAt) }}
								</div>
							</div>
						</button>
					</div>
				</div>

	
				<div class="flex items-center justify-between gap-3 px-5 py-3 border-t border-border-subtle">
					<button
						class="text-xs text-text-tertiary hover:text-error transition-colors"
						:disabled="isSubmitting"
						@click="unlinkAndClose"
					>
						Remove current link
					</button>
					<button class="btn btn-secondary" @click="emit('close')">Close</button>
				</div>
	</ChatDialogShell>
</template>
