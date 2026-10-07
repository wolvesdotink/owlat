/**
 * The thread brief of one Postbox thread (SPEC §7): the `brief.get` read in
 * the UI's locale, and `markSeen` once the viewer has actually looked at the
 * Overview, so "new since you last looked" moves only on a real look.
 *
 * `brief` is `undefined` while loading, `null` when the server has nothing
 * (no access, or no brief row), else the view. A team-mode view (actions,
 * shared mailbox) is passed through: the reader decides not to show it.
 */
import type { Id } from '@owlat/api/dataModel';
import type { BriefModeView, ThreadBriefView } from '../../../api/convex/mail/interpret/briefShape';
import { api } from '@owlat/api';
import { briefLocale, type MailThreadRefArg } from '~/composables/threadBrief/briefApi';
import type { Ref } from 'vue';
import type { BriefAvailability } from '~/utils/threadBriefView';
import {
	BRIEF_MAX_PAGES,
	mergeBriefPages,
	nextCursorOf,
	type BriefItemsState,
	type PagedBrief,
} from '~/utils/threadBriefPages';
import { useConvexQueryMap } from '~/composables/useConvexQueryMap';

export function useThreadBrief(opts: {
	/** The thread, or null to read nothing (a shared mailbox, no thread id yet). */
	threadId: () => string | null | undefined;
}) {
	const { t, locale } = useI18n();

	const threadRef = computed<MailThreadRefArg | null>(() => {
		const id = opts.threadId();
		return id ? { kind: 'mail', id: id as Id<'mailThreads'> } : null;
	});

	const query = useConvexQuery(api.mail.interpret.brief.get, () =>
		threadRef.value
			? { threadRef: threadRef.value, locale: briefLocale(locale.value) }
			: ('skip' as const)
	);

	const view = computed(() => query.data.value as ThreadBriefView | null | undefined);

	// Later item pages, walked in cursor order up to the bound (utils/threadBriefPages).
	let pages: Map<string, { data: Ref<unknown> }> | null = null;
	const cursors = computed(() => {
		const out: string[] = [];
		let cursor = view.value?.mode === 'brief' ? nextCursorOf(view.value) : null;
		while (cursor && out.length < BRIEF_MAX_PAGES - 1) {
			out.push(cursor);
			cursor = nextCursorOf(pages?.get(cursor)?.data.value as ThreadBriefView | null | undefined);
		}
		return out;
	});
	pages = useConvexQueryMap(api.mail.interpret.brief.get, cursors, (cursor) =>
		threadRef.value
			? { threadRef: threadRef.value, locale: briefLocale(locale.value), cursor }
			: 'skip'
	);

	const paged = computed<PagedBrief | null | undefined>(() => {
		const v = view.value;
		if (v === undefined) return undefined;
		if (v?.mode !== 'brief') return null;
		return mergeBriefPages(
			v,
			cursors.value.map(
				(cursor) => pages?.get(cursor)?.data.value as ThreadBriefView | null | undefined
			)
		);
	});
	/** The personal brief (all loaded pages merged), or null for none / a team view; undefined while loading. */
	const brief = computed<BriefModeView | null | undefined>(() => {
		const p = paged.value;
		return p === undefined ? undefined : (p?.brief ?? null);
	});
	/** Whether the item lists are whole; the Overview never says "nothing to do" otherwise. */
	const itemsState = computed<BriefItemsState>(() => paged.value?.itemsState ?? 'complete');
	const isClosedTruncated = computed(() => paged.value?.isClosedTruncated === true);

	/** What the opening-view rule needs to know (utils/threadBriefView). */
	const availability = computed<BriefAvailability>(() => {
		const b = brief.value;
		if (b === undefined && query.isLoading.value) return 'loading';
		if (!b || b.completeness === 'none') return 'none';
		const reason = b.gap?.reason;
		if (reason === 'short' || reason === 'security') return 'original';
		return 'available';
	});

	const markSeenOp = useBackendOperation(api.mail.interpret.brief.markSeen, {
		label: () => t('components.brief.operations.markSeen'),
		announce: false,
	});
	const seen = new Set<string>();
	/** Record that the viewer looked at this revision of the Overview (once per revision). */
	function markSeen() {
		const ref = threadRef.value;
		const b = brief.value;
		if (!ref || !b || b.completeness === 'none') return;
		const key = `${ref.id}:${b.interpretationRevision}`;
		if (seen.has(key)) return;
		seen.add(key);
		void markSeenOp.run({ threadRef: ref, interpretationRevision: b.interpretationRevision });
	}

	return {
		threadRef,
		/** The raw view, either mode (a shared mailbox reads `actions`). */
		view,
		brief,
		itemsState,
		isClosedTruncated,
		availability,
		isLoading: query.isLoading,
		error: query.error,
		markSeen,
	};
}
