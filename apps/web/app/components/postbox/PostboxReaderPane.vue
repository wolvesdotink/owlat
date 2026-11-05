<script setup lang="ts">
/**
 * Pane 3 of the Postbox layout: the open conversation, or the placeholder that
 * says why there is none. The layout passes the pane's sizing classes.
 *
 * The reader renders mail from strangers, so it sits in its own boundary: a
 * conversation that fails to render leaves the rail, the list and the back bar
 * working, and opening another message recovers the pane.
 */
import type { PostboxReaderMessage } from '~/components/postbox/PostboxThreadReader.vue';
import type { PostboxFindSeed } from '~/composables/postbox/usePostboxThreadFind';
import { POSTBOX_FIND_QUERY_PARAM } from '~/utils/postboxFindSeed';
import { useBlockSize } from '~/composables/postbox/usePostboxReaderStickyBar';

const props = defineProps<{
	activeMessageId?: string | null;
	message?: PostboxReaderMessage;
	/** The flat list's visual order, for auto-advance after triage. */
	advanceIds: string[];
	/** Whichever renderer is on screen, in its row order (Zen previous/next). */
	stepIds: readonly string[];
	/** `/dashboard/postbox/<this>/<id>`: the folder id for a custom folder, else its role. */
	folderPath: string;
	folderName: string;
	zen: boolean;
	/** The open message's read, when it is not in the list. */
	error: Error | null;
	notFound: boolean;
}>();

const emit = defineEmits<{ back: []; retry: [] }>();

// A mail-search hit opened from the palette carries its words (`?find=`): the
// conversation opens with them found, in the message that was hit.
const route = useRoute();
const findSeed = computed<PostboxFindSeed | null>(() => {
	const words = route.query[POSTBOX_FIND_QUERY_PARAM];
	const id = props.activeMessageId;
	return typeof words === 'string' && words.trim() && id ? { query: words, messageId: id } : null;
});

// The reader's sticky bar sticks below the back bar, which is sticky too and
// hidden at lg outside Zen (it then measures 0).
const backBarRef = ref<{ $el: HTMLElement } | null>(null);
const backBarHeight = useBlockSize(() => backBarRef.value?.$el);
</script>

<template>
	<section :style="{ '--pbx-reader-sticky-top': `${backBarHeight}px` }">
		<!-- Drill-in back (mobile; and in Zen, with previous/next). -->
		<PostboxReaderBackBar
			v-if="activeMessageId"
			ref="backBarRef"
			:folder-name="folderName"
			:folder-path="folderPath"
			:active-message-id="activeMessageId"
			:ordered-ids="stepIds"
			:zen="zen"
			@back="emit('back')"
		/>

		<!-- The conversation and its context rail (company, tasks): side by side
		     from 60rem of pane width, the rail under the conversation below that.
		     The reader column is a container of its own, so the Team discussion
		     measures the room the rail leaves it. -->
		<div v-if="message" class="@min-[60rem]:flex @min-[60rem]:items-start">
			<div class="@container min-w-0 flex-1">
				<AppErrorBoundary surface="reader" :reset-keys="[activeMessageId]">
					<!-- Keyed, enter-only swap (postbox-motion.css): the next thread
					     mounts in the same frame the previous one goes. -->
					<PostboxThreadReader
						:key="activeMessageId ?? undefined"
						class="pbx-reader-swap"
						:message="message"
						:advance-ids="advanceIds"
						:folder-role="folderPath"
						:find-seed="findSeed"
					/>
				</AppErrorBoundary>
			</div>
			<PostboxContextRail v-if="message.threadId" :thread-id="message.threadId" />
		</div>
		<PostboxReaderPlaceholder
			v-else
			:error="activeMessageId ? error : null"
			:not-found="!!activeMessageId && notFound"
			:folder-name="folderName"
			@retry="emit('retry')"
			@back="emit('back')"
		/>
	</section>
</template>
