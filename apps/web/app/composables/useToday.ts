import { api } from '@owlat/api';
import { localizedSummary } from '~/utils/clarificationLocale';
import type { Id } from '@owlat/api/dataModel';
import {
	buildTodayModel,
	missingSummaries,
	type MailboxDigest,
	type TodayModel,
} from '~/utils/todayDigest';

/**
 * Everything Today shows, live: the viewer's "since you last looked"
 * watermark, one digest subscription per inbox they read, and the team
 * inbox's informational updates (owners/admins with the team inbox on).
 *
 * The watermark only moves on purpose (`markSeen`), so opening Today by
 * accident never erases what changed.
 */
export function useToday() {
	const { t, locale } = useI18n();
	const { isEnabled } = useFeatureFlag();
	const { isAdmin } = usePermissions();
	const { ids } = useInboxes();

	// Frozen at mount: the first-visit fallback ("the last 24 hours") must not
	// re-key the subscription on every render.
	const mountedAt = Date.now();
	const { data: state, isLoading: stateLoading } = useConvexQuery(api.today.state.get, {
		now: mountedAt,
	});
	const since = computed(() => state.value?.seenAt);

	const digests = useConvexQueryMap(api.today.mailbox.digest, ids, (mailboxId) =>
		since.value === undefined ? 'skip' : { mailboxId, since: since.value, locale: locale.value }
	);

	// One-sentence summaries instead of subject lines, where AI is on. Lines
	// without one ask the summarizer in small batches; each written sentence
	// lands through the live digest read. A failure leaves the subject line.
	const requested = new Set<string>();
	const BATCH = 8;
	watch(
		() =>
			isEnabled('ai')
				? missingSummaries(
						[...digests.values()].map((r) => (r.data.value ?? null) as MailboxDigest | null)
					)
				: [],
		async (missing) => {
			const fresh = missing.filter(
				(m) => !requested.has(`${m.messageId}:${m.sinceCount}:${locale.value}`)
			);
			if (fresh.length === 0) return;
			const batch = fresh.slice(0, BATCH);
			for (const m of batch) requested.add(`${m.messageId}:${m.sinceCount}:${locale.value}`);
			try {
				await requireConvex().action(api.today.summarize.summarizeThreads, {
					locale: locale.value,
					items: batch.map((m) => ({
						messageId: m.messageId as Id<'mailMessages'>,
						sinceCount: m.sinceCount,
					})),
				});
			} catch {
				// Advisory: the subject line stays.
			}
		},
		{ immediate: true }
	);

	const teamOn = computed(() => isAdmin.value && isEnabled('inbox'));
	const { data: teamUpdates } = useConvexQuery(api.inbox.updates.listUpdates, () =>
		teamOn.value ? { view: 'updates' as const, limit: 40 } : 'skip'
	);
	const { data: teamCounts } = useConvexQuery(api.inbox.updates.getUpdateCounts, () =>
		teamOn.value ? {} : 'skip'
	);

	const model = computed<TodayModel>(() =>
		buildTodayModel({
			digests: [...digests.values()].map((r) => (r.data.value ?? null) as MailboxDigest | null),
			teamUpdates: teamUpdates.value ?? [],
			teamCounts: teamCounts.value ?? null,
			since: since.value ?? mountedAt,
			pickSummary: (summary) => (summary ? localizedSummary(summary, locale.value) || null : null),
		})
	);

	const isLoading = computed(() => {
		if (stateLoading.value) return true;
		for (const r of digests.values()) if (r.isLoading.value) return true;
		return false;
	});

	const { run: markSeenRun } = useBackendOperation(api.today.state.markSeen, {
		label: () => t('dashboard.today.operations.markSeen'),
	});
	const { run: undoMarkSeenRun } = useBackendOperation(api.today.state.undoMarkSeen, {
		label: () => t('dashboard.today.operations.markSeen'),
	});

	return {
		since,
		isFallback: computed(() => state.value?.isFallback ?? false),
		previousSeenAt: computed(() => state.value?.previousSeenAt ?? null),
		model,
		isLoading,
		teamOn,
		markSeen: () => markSeenRun({}),
		undoMarkSeen: () => undoMarkSeenRun({}),
	};
}
