import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

/** Tailwind's `xl`: from here on the discussion starts open. */
const SIDE_PANEL_QUERY = '(min-width: 1280px)';

/**
 * Open/closed state of the reader's "Team discussion" panel, shared by the
 * reader toolbar toggle and the panel itself.
 *
 * Wide screens show the panel beside the conversation unless the user closed
 * it; narrow screens keep it closed until "Discuss" opens it below the
 * messages. An explicit choice sticks for the session across threads.
 *
 * `articleClass` is what the reader's `<article>` needs to make room for the
 * side panel: a two-column grid once the reader PANE (an `@container` in
 * PostboxLayout) is at least 52rem wide. A container query rather than the
 * viewport, because the same reader also renders in narrower hosts (the Today
 * overlay, the search preview) where a side column would crush the email —
 * there, and in a narrow pane, the panel simply sits below the conversation.
 */
export function usePostboxThreadDiscussionPanel() {
	const { isEnabled } = useFeatureFlag();
	const isWide = useMediaQuery(SIDE_PANEL_QUERY);
	const choice = useState<boolean | null>('postbox-thread-discussion-open', () => null);

	const isAvailable = computed(() => isEnabled('chat'));
	const isOpen = computed(() => isAvailable.value && (choice.value ?? isWide.value));
	const articleClass = computed(() =>
		isOpen.value
			? '@min-[52rem]:max-w-7xl @min-[52rem]:grid @min-[52rem]:grid-cols-[minmax(0,1fr)_20rem] @min-[52rem]:gap-x-6 @min-[52rem]:items-start'
			: ''
	);

	function toggle() {
		choice.value = !isOpen.value;
	}

	return { isAvailable, isOpen, articleClass, toggle };
}

/**
 * The discussion data for one Postbox thread (`chat.mailDiscussion.getForThread`):
 * null while loading, when chat is off, or when the caller cannot read the
 * mailbox. `count` feeds the toolbar badge and a future "N in discussion" row
 * marker.
 */
export function usePostboxThreadDiscussionData(threadId: () => string | null | undefined) {
	const { isEnabled } = useFeatureFlag();
	const { data, isLoading } = useConvexQuery(api.chat.mailDiscussion.getForThread, () => {
		const id = threadId();
		return id && isEnabled('chat') ? { threadId: id as Id<'mailThreads'> } : 'skip';
	});
	const discussion = computed(() => data.value ?? null);
	const count = computed(() => discussion.value?.count ?? 0);
	return { discussion, count, isLoading };
}
