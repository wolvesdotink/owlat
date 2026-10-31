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
</script>

<template>
	<section>
		<!-- Drill-in back (mobile; and in Zen, with previous/next). -->
		<PostboxReaderBackBar
			v-if="activeMessageId"
			:folder-name="folderName"
			:folder-path="folderPath"
			:active-message-id="activeMessageId"
			:ordered-ids="stepIds"
			:zen="zen"
			@back="emit('back')"
		/>

		<AppErrorBoundary v-if="message" surface="reader" :reset-keys="[activeMessageId]">
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
