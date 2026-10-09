/**
 * The team thread stream of one thread (SPEC §7 "Team"): the newest page
 * live, older pages on "Show earlier", merged into one list
 * (`utils/teamStream`). A Team Inbox thread reads `inbox.teamStream.page`, a
 * shared-mailbox thread `mail.interpret.teamStream.page`.
 *
 * The stream holds internal notes, so it is shown to the team only and never
 * handed to anything that writes mail.
 */
import type { Ref } from 'vue';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type {
	TeamStreamEntry,
	TeamStreamPage,
} from '../../../../api/convex/mail/interpret/briefShape';
import { briefLocale } from '~/composables/threadBrief/briefApi';
import { useConvexQueryMap } from '~/composables/useConvexQueryMap';
import { mergeStreamPages, newestPosition } from '~/utils/teamStream';

export type TeamStreamTarget =
	| { kind: 'team'; id: Id<'conversationThreads'> }
	| { kind: 'mail'; id: Id<'mailThreads'> };

export function useTeamStream(opts: {
	target: () => TeamStreamTarget | null;
	enabled?: () => boolean;
}) {
	const { t, locale } = useI18n();
	const target = computed(() => (opts.enabled?.() === false ? null : opts.target()));
	const lang = computed(() => briefLocale(locale.value));

	const teamFirst = useConvexQuery(api.inbox.teamStream.page, () =>
		target.value?.kind === 'team'
			? { threadId: target.value.id, locale: lang.value }
			: ('skip' as const)
	);
	const mailFirst = useConvexQuery(api.mail.interpret.teamStream.page, () =>
		target.value?.kind === 'mail'
			? { threadId: target.value.id, locale: lang.value }
			: ('skip' as const)
	);
	const first = computed(
		() =>
			(target.value?.kind === 'team' ? teamFirst.data.value : mailFirst.data.value) as
				| TeamStreamPage
				| null
				| undefined
	);

	// How many older pages the viewer asked for; each follows the cursor of the one before.
	const requested = ref(0);
	watch(
		() => (target.value ? `${target.value.kind}:${target.value.id}` : ''),
		() => {
			requested.value = 0;
		}
	);
	// The page maps are created after the cursor chain that keys them, so they
	// live in a ref: setting it re-runs the chain (the useThreadBrief pattern).
	type PageMap = Map<string, { data: Ref<unknown> }>;
	const maps = shallowRef<{ team: PageMap; mail: PageMap } | null>(null);
	const pageOf = (cursor: string) =>
		maps.value?.[target.value?.kind ?? 'team'].get(cursor)?.data.value as
			| TeamStreamPage
			| null
			| undefined;
	const cursors = computed(() => {
		const out: string[] = [];
		let page = first.value;
		while (page && !page.isDone && page.cursor && out.length < requested.value) {
			out.push(page.cursor);
			page = pageOf(page.cursor);
		}
		return out;
	});
	maps.value = {
		team: useConvexQueryMap(api.inbox.teamStream.page, cursors, (cursor) =>
			target.value?.kind === 'team'
				? { threadId: target.value.id, locale: lang.value, cursor }
				: 'skip'
		),
		mail: useConvexQueryMap(api.mail.interpret.teamStream.page, cursors, (cursor) =>
			target.value?.kind === 'mail'
				? { threadId: target.value.id, locale: lang.value, cursor }
				: 'skip'
		),
	};

	const loaded = computed(() => [first.value, ...cursors.value.map(pageOf)]);
	const entries = computed<TeamStreamEntry[]>(() =>
		mergeStreamPages(loaded.value.map((page) => page?.entries))
	);
	const oldestLoaded = computed(() => loaded.value.at(-1));
	// Every older page stays reachable: nothing caps the walk back.
	const hasEarlier = computed(() => {
		const page = oldestLoaded.value;
		return !!page && !page.isDone;
	});
	const isLoadingEarlier = computed(() => oldestLoaded.value === undefined && requested.value > 0);
	const isLoading = computed(() => target.value !== null && first.value === undefined);

	function loadEarlier() {
		if (!hasEarlier.value || isLoadingEarlier.value) return;
		requested.value = cursors.value.length + 1;
	}

	// "New since you looked": the newest entry seen is saved once per position.
	const markSeenOp = useBackendOperation(api.mail.interpret.brief.markSeen, {
		label: () => t('components.team.stream.markSeenOperation'),
		announce: false,
	});
	const marked = new Set<string>();
	function markSeen() {
		const current = target.value;
		const position = newestPosition(entries.value);
		if (!current || !position) return;
		const mark = `${current.kind}:${current.id}:${position.key}`;
		if (marked.has(mark)) return;
		marked.add(mark);
		void markSeenOp.run({ threadRef: current, streamPosition: position });
	}

	// The place saved before this visit: the "New" divider stays put while this
	// visit moves the saved place forward.
	const seenAtOpen = ref<{ target: string; position: { at: number; key: string } | null } | null>(
		null
	);
	watch(
		first,
		(page) => {
			const current = target.value;
			if (!current || page === undefined) return;
			const key = `${current.kind}:${current.id}`;
			if (seenAtOpen.value?.target === key) return;
			seenAtOpen.value = { target: key, position: page?.seenPosition ?? null };
		},
		{ immediate: true }
	);

	return {
		entries,
		seenPosition: computed(() => seenAtOpen.value?.position ?? null),
		isAvailable: computed(() => first.value !== null),
		/** The first page has arrived and the viewer may read the stream. */
		isReady: computed(() => first.value !== undefined && first.value !== null),
		isLoading,
		hasEarlier,
		isLoadingEarlier,
		loadEarlier,
		markSeen,
	};
}

export type TeamStream = ReturnType<typeof useTeamStream>;
