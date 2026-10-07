/**
 * The thread brief inside the Postbox reader (SPEC §7), kept out of
 * PostboxThreadReader.vue, which is at its size cap:
 *
 *  - the brief read and the Overview / Conversation view (useThreadBrief,
 *    useThreadView), for personal mailboxes only. A shared (team) mailbox gets
 *    no switch, no Overview and no per-message latest lines: `isShared` is the
 *    seam the team stream fills in;
 *  - a cited quote: its message is expanded, scrolled to and the quote marked
 *    (`citeQuoteFor`), and the header line says what is being shown;
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
import { messageLatestMap, resolveCite, type BriefAction } from '~/utils/threadBriefItems';
import type { BriefSource } from '~/utils/threadBriefContext';

interface ReaderMessageLike {
	_id: string;
	fromName?: string;
	fromAddress: string;
	receivedAt: number;
}

export type PostboxReaderBrief = ReturnType<typeof usePostboxReaderBrief>;

export function usePostboxReaderBrief(opts: {
	mailboxId: () => string;
	threadId: () => string | undefined;
	messages: Ref<readonly ReaderMessageLike[]>;
	expanded: Ref<ReadonlySet<string>>;
	toggleExpanded: (id: string) => void;
	/** The reader's PGP/S-MIME structure per message (a clearsigned one scopes the brief). */
	secureClass: (msg: { _id: string }) => string;
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

	// The cited message opens, so its quote can be scrolled to and marked.
	watch(
		() => cited.value?.messageId,
		(id) => {
			if (id && !opts.expanded.value.has(id)) opts.toggleExpanded(id);
		},
		{ immediate: true }
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
	function citeQuoteFor(messageId: string): string | null {
		const c = cited.value;
		return c && c.messageId === messageId ? (c.quote ?? '') : null;
	}

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
		brief: read.brief,
		switchView,
		showsOverview,
		cited,
		setView: (next: ThreadView) => viewState.setView(next),
		openCite: (ref: string, quoteIndex: number) => viewState.openCite({ ref, quoteIndex }),
		backToOverview: viewState.backToOverview,
		latestFor,
		citeQuoteFor,
		sourceOf,
		react: reactions.run,
	};
}
