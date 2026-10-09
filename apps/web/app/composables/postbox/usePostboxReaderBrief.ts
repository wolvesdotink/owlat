/**
 * The thread brief inside the Postbox reader (SPEC §7), kept out of
 * PostboxThreadReader.vue, which is at its size cap:
 *
 *  - the brief read and the Overview / Conversation view (useThreadBrief,
 *    useThreadView), for personal mailboxes only. A shared (team) mailbox gets
 *    no switch, no Overview and no per-message latest lines: `isShared` is the
 *    seam the team stream fills in;
 *  - a cited quote: its message is loaded (earlier pages are walked back to
 *    it, like an opened search hit), expanded, scrolled to and the quote
 *    marked (`citeQuoteFor`); the header line says what is being shown, or
 *    that the message could not be reached;
 *  - the messages whose exact wording matters (legal notices, changed terms,
 *    payment details): loaded and expanded the same way, and kept open beside
 *    the Overview (`exactWordingMessages`);
 *  - the collapsed rows' "latest update" sentence (`latestFor`);
 *  - marking the brief seen once the Overview has been on screen;
 *  - running item reactions, with the replying ones handed to the reader.
 */
import type { Ref } from 'vue';
import type { ThreadView } from '@owlat/shared/threadBrief';
import type { BriefItemView } from '../../../../api/convex/mail/interpret/briefShape';
import { useThreadBrief } from '~/composables/useThreadBrief';
import { useThreadView } from '~/composables/useThreadView';
import { useBriefReactions } from '~/composables/threadBrief/useBriefReactions';
import { THREAD_ANCHOR_PAGE_LIMIT } from '~/composables/postbox/postboxThreadPage';
import { messageLatestMap, resolveCite, type BriefAction } from '~/utils/threadBriefItems';
import type { BriefSource } from '~/utils/threadBriefContext';
import type { CitedQuote } from '~/utils/postboxQuoteHighlight';
import type { SecureMessageClass } from '@owlat/shared/secureMessage';

interface ReaderMessageLike {
	_id: string;
	fromName?: string;
	fromAddress: string;
	receivedAt: number;
}

/** The reader's paging, for walking back to a message the brief points at. */
interface ReaderPages {
	hasEarlier: Readonly<Ref<boolean>>;
	loadingEarlier: Readonly<Ref<boolean>>;
	loadEarlier: () => void;
}

/** Where a cited message is: on screen, on its way, or out of reach. */
export type CiteState = 'loading' | 'shown' | 'unreachable';

export type PostboxReaderBrief = ReturnType<typeof usePostboxReaderBrief>;

export function usePostboxReaderBrief(opts: {
	mailboxId: () => string;
	threadId: () => string | undefined;
	messages: Ref<readonly ReaderMessageLike[]>;
	expanded: Ref<ReadonlySet<string>>;
	toggleExpanded: (id: string) => void;
	pages: ReaderPages;
	/** The reader's PGP/S-MIME structure per message (a clearsigned one scopes the brief). */
	secureClass: (msg: { _id: string }) => SecureMessageClass;
	/** A replying reaction or the brief's Reply: open Answer mode (guarded). */
	onReply: (item: BriefItemView | null, action: BriefAction | null) => void;
}) {
	const { byId } = useInboxes();
	const isShared = computed(() => byId.value.get(opts.mailboxId() as never)?.scope === 'shared');

	const read = useThreadBrief({ threadId: () => (isShared.value ? null : opts.threadId()) });
	const viewState = useThreadView({
		threadRef: () => read.threadRef.value,
		brief: () => read.brief.value,
		availability: () => read.availability.value,
		isShared: () => isShared.value,
	});

	/** The header switch's state; null hides it (shared mailboxes). */
	const switchView = computed(() => (isShared.value ? null : viewState.view.value));
	const showsOverview = computed(() => !isShared.value && viewState.view.value !== 'conversation');

	const cited = computed(() => {
		const brief = read.brief.value;
		const cite = viewState.cite.value;
		return brief && cite ? resolveCite(brief, cite) : null;
	});

	/** Messages whose original stays open beside the Overview. */
	const exactWordingIds = computed(() =>
		isShared.value ? [] : (read.brief.value?.exactWording ?? []).map((e) => e.messageId)
	);

	// Messages the brief needs on screen: walk back through earlier pages
	// until they are loaded (bounded like the reader's own anchor walk), and
	// expand them once they arrive.
	const loadedIds = computed(() => new Set(opts.messages.value.map((m) => m._id)));
	// A team source marker on a shared mailbox (TeamPinnedItems): the cited email
	// is brought in by the same walk, then scrolled to and ringed.
	const messageCite = ref<string | null>(null);
	const wanted = computed(() => [
		...(cited.value ? [cited.value.messageId] : []),
		...(messageCite.value ? [messageCite.value] : []),
		...exactWordingIds.value,
	]);
	const walks = ref(0);
	watch(
		() => [cited.value?.messageId, messageCite.value],
		() => {
			walks.value = 0;
		}
	);
	watch(
		() =>
			[
				wanted.value,
				loadedIds.value,
				opts.pages.hasEarlier.value,
				opts.pages.loadingEarlier.value,
			] as const,
		([ids, loaded, more, loading]) => {
			for (const id of ids) {
				if (loaded.has(id) && !opts.expanded.value.has(id)) opts.toggleExpanded(id);
			}
			const missing = ids.some((id) => !loaded.has(id));
			if (missing && more && !loading && walks.value < THREAD_ANCHOR_PAGE_LIMIT) {
				walks.value++;
				opts.pages.loadEarlier();
			}
		},
		{ immediate: true }
	);

	function stateOf(id: string | undefined | null): CiteState | null {
		if (!id) return null;
		if (loadedIds.value.has(id)) return 'shown';
		const canWalk = opts.pages.hasEarlier.value && walks.value < THREAD_ANCHOR_PAGE_LIMIT;
		return opts.pages.loadingEarlier.value || canWalk ? 'loading' : 'unreachable';
	}
	const citeState = computed<CiteState | null>(() => stateOf(cited.value?.messageId));
	/** The team marker's email: on its way, or out of reach (kept until shown). */
	const messageCiteState = computed(() => stateOf(messageCite.value));
	watch(
		() =>
			messageCite.value &&
			loadedIds.value.has(messageCite.value) &&
			opts.expanded.value.has(messageCite.value),
		(isReady) => {
			const id = messageCite.value;
			if (!isReady || !id) return;
			void nextTick(() => {
				const el = document.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`);
				el?.scrollIntoView?.({ block: 'start' });
				el?.classList.add('ring-2', 'ring-brand/50');
				setTimeout(() => el?.classList.remove('ring-2', 'ring-brand/50'), 1600);
				messageCite.value = null;
			});
		}
	);

	// Seen once the Overview is actually showing a brief.
	watch(
		() => [viewState.view.value, read.brief.value?.interpretationRevision] as const,
		([view]) => {
			if (view === 'overview' && !isShared.value) read.markSeen();
		},
		{ immediate: true }
	);

	const latest = computed(() => (isShared.value ? new Map() : messageLatestMap(read.brief.value)));
	function latestFor(messageId: string): string | null {
		return latest.value.get(messageId) ?? null;
	}
	/** The cited quote in this message (its words and which occurrence), or null. */
	function citeQuoteFor(messageId: string): CitedQuote | null {
		const c = cited.value;
		if (!c || c.messageId !== messageId) return null;
		return {
			quote: c.quote ?? '',
			...(c.occurrence !== undefined ? { occurrence: c.occurrence } : {}),
			...(c.occurrenceCount !== undefined ? { occurrenceCount: c.occurrenceCount } : {}),
		};
	}

	/** Messages whose original stays open beside the Overview (loaded or not). */
	const exactWording = computed(() => new Set(exactWordingIds.value));

	const sources = computed(
		() =>
			new Map<string, BriefSource>(
				opts.messages.value.map((m) => [
					m._id,
					{ name: m.fromName, email: m.fromAddress, at: m.receivedAt },
				])
			)
	);
	function sourceOf(messageId: string): BriefSource | undefined {
		return sources.value.get(messageId);
	}

	const isSigned = computed(() =>
		opts.messages.value.some((m) => opts.secureClass(m) === 'pgp-clearsigned')
	);

	const reactions = useBriefReactions({ onReply: (item, action) => opts.onReply(item, action) });

	return {
		isShared,
		isSigned,
		/** The personal thread the brief reads, or null (a shared mailbox). */
		threadRef: read.threadRef,
		brief: read.brief,
		itemsState: read.itemsState,
		isClosedTruncated: read.isClosedTruncated,
		switchView,
		showsOverview,
		cited,
		citeState,
		exactWording,
		secureClass: opts.secureClass,
		setView: (next: ThreadView) => viewState.setView(next),
		openCite: (ref: string, quoteIndex: number) => viewState.openCite({ ref, quoteIndex }),
		backToOverview: viewState.backToOverview,
		latestFor,
		citeQuoteFor,
		sourceOf,
		/** Show a message of the thread (loading earlier pages as needed). */
		citeMessage: (messageId: string) => (messageCite.value = messageId),
		messageCiteState,
		react: reactions.run,
	};
}
