import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { Ref } from 'vue';
import { ALL_SCOPE, TEAM_SCOPE, type WorkbenchScope } from '~/utils/workbench';
import { buildTodayModel, type MailboxDigest, type TodayModel } from '~/utils/todayDigest';

/** What one Workbench tab renders: its model and the watermark it counts from. */
interface WorkbenchView {
	model: TodayModel;
	since: number | undefined;
	isFallback: boolean;
	previousSeenAt: number | null;
	/**
	 * A server time that everything in this view arrived by, and nothing left
	 * out of it did: the digest's read time, or on the team tab the newest
	 * update shown. Marking the tab seen "as of what was on screen" uses it.
	 */
	asOf: number | null;
}

/**
 * The caller's Workbench state: the hide list and every tab's watermark, in
 * one read without a scope. The page and the tab share this one subscription
 * (same args, so the subscription registry hands both the same one), and a
 * tab switch picks the new tab's watermark locally instead of waiting on a
 * query of its own.
 */
function useTodayState() {
	return useConvexQuery(api.today.state.get, {});
}

/**
 * Everything one Workbench tab shows, live: the viewer's "since you last
 * looked" watermark for that tab, and either that mailbox's digest or — on the
 * team inbox tab (owners/admins with the team inbox on) — its informational
 * updates. Only the open tab subscribes, so a viewer with many inboxes pays
 * for one digest at a time, except on the All tab, which reads every inbox the
 * viewer shows (and the team inbox's updates) and is marked seen as a whole.
 *
 * The digest reads the watermark on the server, so it only waits for the tab
 * to be known and loads alongside the state read, not after it.
 *
 * The watermark only moves on purpose (`markSeen`), so opening a tab by
 * accident never erases what changed.
 */
export function useWorkbench(
	scope: Ref<WorkbenchScope | null>,
	/** The mailboxes the All tab combines: the ones the viewer shows on the Workbench. */
	allMailboxIds: Ref<readonly Id<'mailboxes'>[]> = ref([])
) {
	const { t, locale } = useI18n();
	const { isEnabled } = useFeatureFlag();
	const { isAdmin } = usePermissions();
	// "Show the brief above conversations": off, no AI sentence on a mail line.
	const { autoSummarize } = usePostboxSettings();

	// Only the team tab's model reads this, and only until the state arrives.
	const mountedAt = Date.now();
	const { data: state, isLoading: stateLoading } = useTodayState();
	const watermark = computed(() => {
		const watermarks = state.value?.watermarks;
		if (!watermarks || !scope.value) return undefined;
		return watermarks.marks.find((m) => m.scope === scope.value) ?? watermarks.unmarked;
	});
	const since = computed(() => watermark.value?.seenAt);

	const isTeam = computed(() => scope.value === TEAM_SCOPE);
	const isAll = computed(() => scope.value === ALL_SCOPE);
	const mailboxIds = computed<Id<'mailboxes'>[]>(() => {
		if (isAll.value) return [...allMailboxIds.value];
		return scope.value && !isTeam.value ? [scope.value as Id<'mailboxes'>] : [];
	});
	const digests = useConvexQueryMap(api.today.mailbox.digest, mailboxIds, (mailboxId) => ({
		mailboxId,
		locale: locale.value,
	}));

	const teamOn = computed(() => isAdmin.value && isEnabled('inbox'));
	const teamTab = computed(() => teamOn.value && (isTeam.value || isAll.value));
	const { data: teamUpdates, isLoading: teamLoading } = useConvexQuery(
		api.inbox.updates.listUpdates,
		() => (teamTab.value ? { view: 'updates' as const, limit: 40 } : 'skip')
	);
	const { data: teamCounts } = useConvexQuery(api.inbox.updates.getUpdateCounts, () =>
		teamTab.value ? {} : 'skip'
	);

	const liveView = computed<WorkbenchView>(() => {
		const model = buildTodayModel({
			digests: mailboxIds.value.map(
				(id) => (digests.get(id)?.data.value ?? null) as MailboxDigest | null
			),
			teamUpdates: teamTab.value ? (teamUpdates.value ?? []) : [],
			teamCounts: teamTab.value ? (teamCounts.value ?? null) : null,
			since: since.value ?? mountedAt,
			isBriefShown: autoSummarize.value,
		});
		const teamTimes = [...model.worth, ...model.also].map((line) => line.at);
		// The latest read among the digests on screen. A digest that has not been
		// read again since has had nothing change in its mailbox, so marking seen
		// as of the latest read covers every line All shows.
		const digestTimes = mailboxIds.value
			.map((id) => (digests.get(id)?.data.value as MailboxDigest | null | undefined)?.generatedAt)
			.filter((at): at is number => at !== undefined);
		const digestTime = digestTimes.length > 0 ? Math.max(...digestTimes) : undefined;
		return {
			model,
			since: since.value,
			isFallback: watermark.value?.isFallback ?? false,
			previousSeenAt: watermark.value?.previousSeenAt ?? null,
			asOf: isTeam.value
				? teamTimes.length > 0
					? Math.max(...teamTimes)
					: null
				: (digestTime ?? (teamTimes.length > 0 ? Math.max(...teamTimes) : null)),
		};
	});

	const isLoading = computed(() => {
		if (stateLoading.value) return true;
		if (teamTab.value && teamLoading.value) return true;
		// The open tab's own digest: on a switch the watermark flips at once, and
		// the map only swaps the old tab's digest for the new one's a tick later.
		for (const id of mailboxIds.value) {
			const r = digests.get(id);
			if (!r || r.isLoading.value) return true;
		}
		return false;
	});

	// keepPreviousData for the whole tab. A tab switch re-keys the digest (or
	// the team reads) while the watermark flips at once, so the query-level
	// option would pair the new tab's watermark with the old tab's digest.
	// Instead the last tab that finished loading stays on screen, marked
	// `isStale`, until the new one has. Only the first load shows a skeleton.
	const settledView = shallowRef<WorkbenchView | null>(null);
	watch(
		[isLoading, liveView],
		([loading, view]) => {
			if (!loading) settledView.value = view;
		},
		{ immediate: true, flush: 'sync' }
	);
	const isStale = computed(() => isLoading.value && settledView.value !== null);
	const view = computed(() =>
		isStale.value && settledView.value ? settledView.value : liveView.value
	);

	const { run: markSeenRun } = useBackendOperation(api.today.state.markSeen, {
		label: () => t('dashboard.today.operations.markSeen'),
	});
	const { run: undoMarkSeenRun } = useBackendOperation(api.today.state.undoMarkSeen, {
		label: () => t('dashboard.today.operations.markSeen'),
	});
	// The numbers live in the header's tiles; the sentence only says "since when".
	const sinceLabel = computed(() => {
		const at = view.value.since;
		if (at === undefined) return '';
		if (view.value.isFallback) return t('components.today.scope.sinceFallback');
		const date = new Date(at);
		const sameDay = date.toDateString() === new Date().toDateString();
		const when = new Intl.DateTimeFormat(undefined, {
			...(sameDay ? {} : { weekday: 'long' }),
			hour: 'numeric',
			minute: '2-digit',
		}).format(date);
		return t('components.today.scope.since', { when });
	});

	return {
		since: computed(() => view.value.since),
		sinceLabel,
		isFallback: computed(() => view.value.isFallback),
		previousSeenAt: computed(() => view.value.previousSeenAt),
		model: computed(() => view.value.model),
		isLoading,
		/**
		 * The page shows the previous tab while this one loads. Nothing on screen
		 * belongs to the open tab yet, so "mark as seen" must wait.
		 */
		isStale,
		/** Server time of what is on screen (see WorkbenchView.asOf). */
		asOf: computed(() => view.value.asOf),
		teamOn,
		/**
		 * Mark a tab as seen; the open one unless told otherwise (leaving a tab).
		 * `at` stops the watermark at the moment the viewer last saw the tab, so
		 * mail that arrived after that (out of view) stays new.
		 */
		markSeen: (target: WorkbenchScope | null = scope.value, at?: number) =>
			markSeenRun({
				...(target && target !== ALL_SCOPE ? { scope: target as Id<'mailboxes'> | 'team' } : {}),
				...(at === undefined ? {} : { at }),
			}),
		undoMarkSeen: (target: WorkbenchScope | null = scope.value) =>
			undoMarkSeenRun(
				target && target !== ALL_SCOPE ? { scope: target as Id<'mailboxes'> | 'team' } : {}
			),
	};
}

/**
 * Which inboxes get a Workbench tab: a per-person hide list, so an inbox the
 * viewer joins later gets its tab without a visit to the picker. Choosing the
 * open tab depends on it, so it comes from the same unscoped state read the
 * tab takes its watermark from. A toggle shows at once; the live read confirms.
 */
export function useWorkbenchInboxChoice() {
	const { t } = useI18n();
	const { data: state } = useTodayState();
	const pendingShown = ref(new Map<Id<'mailboxes'>, boolean>());
	const hiddenMailboxIds = computed<Id<'mailboxes'>[]>(() => {
		const hidden = new Set(state.value?.hiddenMailboxIds ?? []);
		for (const [mailboxId, shown] of pendingShown.value) {
			if (shown) hidden.delete(mailboxId);
			else hidden.add(mailboxId);
		}
		return [...hidden];
	});

	const { run: setShownRun } = useBackendOperation(api.today.state.setMailboxShown, {
		label: () => t('dashboard.today.operations.chooseInboxes'),
	});
	async function setInboxShown(mailboxId: Id<'mailboxes'>, shown: boolean) {
		pendingShown.value = new Map(pendingShown.value).set(mailboxId, shown);
		await setShownRun({ mailboxId, shown });
		const next = new Map(pendingShown.value);
		next.delete(mailboxId);
		pendingShown.value = next;
	}

	return { hiddenMailboxIds, setInboxShown };
}
