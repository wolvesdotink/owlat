/**
 * Split-inbox sections (idea 24) — the feed behind PostboxThreadSectionList.
 *
 * Reads `mail.sections.listSections`, which returns one page PER SECTION so the
 * renderer can page each independently (a shared page would let a chatty section
 * starve a quiet one — see the module comment on the server side). This
 * composable owns the per-section limits, the collapsed state, and nothing else:
 * the section set, the order and the counts are all the server's answer.
 */

import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { PostboxThreadRowMessage } from '~/components/postbox/PostboxThreadRow.vue';
import {
	growPostboxSection,
	isPostboxSectionAtMax,
	postboxSectionKey,
	postboxSectionLimitArgs,
} from '~/utils/postboxSections';

export interface PostboxInboxSection {
	/** `null` is the unnamed remainder — rendered as "Everything else". */
	name: string | null;
	key: string;
	messages: PostboxThreadRowMessage[];
	unreadCount: number;
	isUnreadCapped: boolean;
	/** More mail exists in THIS section, and its page can still grow. */
	canLoadMore: boolean;
}

export function usePostboxThreadSections(args: {
	mailboxId: Ref<Id<'mailboxes'> | null>;
	enabled: Ref<boolean>;
}) {
	// One entry per section the user has grown; absent means the server default.
	const limits = ref<Record<string, number>>({});

	const { data, isLoading } = useConvexQuery(
		api.mail.sections.listSections,
		() =>
			args.enabled.value && args.mailboxId.value
				? { mailboxId: args.mailboxId.value, limits: postboxSectionLimitArgs(limits.value) }
				: 'skip',
		{ keepPreviousData: true }
	);

	const sections = computed<PostboxInboxSection[]>(() =>
		(data.value?.sections ?? []).map((section) => {
			const key = postboxSectionKey(section.name);
			return {
				name: section.name,
				key,
				messages: section.messages as unknown as PostboxThreadRowMessage[],
				unreadCount: section.unreadCount,
				isUnreadCapped: section.isUnreadCapped,
				canLoadMore: section.hasMore && !isPostboxSectionAtMax(limits.value, key),
			};
		})
	);

	/** Grow exactly one section's page; every other section stays where it was. */
	function loadMore(key: string) {
		limits.value = growPostboxSection(limits.value, key);
	}

	// Collapsed per section, remembered across navigations for the session —
	// the same shape the category view uses.
	const collapsed = useState<Record<string, boolean>>('postbox:section-collapsed', () => ({}));
	function toggle(key: string) {
		collapsed.value = { ...collapsed.value, [key]: !collapsed.value[key] };
	}

	return { sections, isLoading, loadMore, collapsed, toggle };
}
