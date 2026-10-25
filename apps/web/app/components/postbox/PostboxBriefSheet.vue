<script setup lang="ts">
/**
 * "Full brief" (read on arrival §3): the whole thread brief in a side
 * sheet beside the conversation. It is the card the old Overview showed, so
 * nothing it held is lost: latest, where things stand, every item with its
 * reactions, activity, people and files, the originals whose exact wording
 * matters, and the same people's other open threads.
 *
 * A cite (a source marker) closes the sheet and shows its passage in the
 * conversation; so does "open the conversation" from the brief's banners.
 */
import { useModalFocus } from '@owlat/ui/composables/useModalFocus';
import type { PostboxReaderBrief } from '~/composables/postbox/usePostboxReaderBrief';
import type { PostboxReaderMessage } from './PostboxThreadReader.vue';
import { formatCompactRelativeTime } from '~/utils/formatters';
import ThreadBrief from '~/components/brief/ThreadBrief.vue';
import BriefElsewhere from '~/components/brief/BriefElsewhere.vue';

const props = defineProps<{
	open: boolean;
	/** The reader's brief state (usePostboxReaderBrief). */
	state: PostboxReaderBrief;
	/** The loaded conversation, oldest first. */
	messages: readonly PostboxReaderMessage[];
}>();

const emit = defineEmits<{ 'update:open': [open: boolean] }>();

const { t } = useI18n();
const dialogEl = ref<HTMLElement | null>(null);
useModalFocus(dialogEl, () => props.open, close);

function close() {
	emit('update:open', false);
}

const latest = computed(() => props.messages[props.messages.length - 1]);
const latestNote = computed(() => {
	const m = latest.value;
	return m ? `${m.fromName || m.fromAddress} · ${formatCompactRelativeTime(m.receivedAt)}` : '';
});
const exactMessages = computed(() =>
	props.messages.filter((m) => props.state.exactWording.value.has(m._id))
);

function onCite(ref: string, quoteIndex: number) {
	close();
	props.state.openCite(ref, quoteIndex);
}

/** Back to the conversation, at the first message whose wording matters, if any. */
function toConversation() {
	close();
	const id = props.state.firstExactWordingId.value;
	if (id) props.state.citeMessage(id);
}
</script>

<template>
	<Teleport to="body">
		<Transition
			enter-active-class="transition-opacity duration-(--motion-moderate)"
			enter-from-class="opacity-0"
			leave-active-class="transition-opacity duration-(--motion-moderate-exit)"
			leave-to-class="opacity-0"
		>
			<div v-if="open" class="fixed inset-0 z-40 bg-scrim/50" @click="close" />
		</Transition>
		<Transition
			enter-active-class="transition-transform duration-(--motion-moderate)"
			enter-from-class="translate-x-full"
			leave-active-class="transition-transform duration-(--motion-moderate-exit)"
			leave-to-class="translate-x-full"
		>
			<aside
				v-if="open"
				ref="dialogEl"
				class="fixed top-0 right-0 z-50 flex h-full w-full max-w-xl flex-col overflow-y-auto border-l border-border-subtle bg-bg-base"
				tabindex="-1"
				role="dialog"
				aria-modal="true"
				:aria-label="t('postbox.reader.sheet.title')"
				data-testid="brief-sheet"
			>
				<header class="flex items-center gap-3 border-b border-border-subtle px-4 py-3">
					<h2 class="flex-1 text-sm font-medium text-text-primary">
						{{ t('postbox.reader.sheet.title') }}
					</h2>
					<button
						type="button"
						class="text-text-tertiary hover:text-text-primary"
						:aria-label="t('common.close')"
						@click="close"
					>
						<Icon name="lucide:x" class="h-4 w-4" />
					</button>
				</header>
				<div class="space-y-3 p-4">
					<ThreadBrief
						:brief="state.brief.value"
						:source-of="state.sourceOf"
						:is-signed="state.isSigned.value"
						:latest-note="latestNote"
						:items-state="state.itemsState.value"
						:is-closed-truncated="state.isClosedTruncated.value"
						@react="state.react"
						@cite="onCite"
						@open-conversation="toConversation"
					/>
					<PostboxThreadExactWording
						:messages="exactMessages"
						:secure-class="state.secureClass"
						:is-truncated="state.brief.value?.isExactWordingTruncated === true"
						@open-conversation="toConversation"
					/>
					<BriefElsewhere
						:thread-ref="state.threadRef.value"
						class="rounded-lg border border-border-subtle bg-bg-elevated px-3.5 py-3"
					/>
				</div>
			</aside>
		</Transition>
	</Teleport>
</template>
