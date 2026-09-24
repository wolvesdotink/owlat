import { api } from '@owlat/api';
import type { FunctionReturnType } from 'convex/server';
import type { ComputedRef, MaybeRefOrGetter } from 'vue';
import type { Id } from '@owlat/api/dataModel';

/**
 * Drives the "Migrate from Google" wizard. Reads the live migration status
 * (Convex-reactive, so progress updates without polling) plus the connected
 * external account, and derives the wizard step. The connect form itself lives
 * in the page; this owns the migration lifecycle (start / cancel) and progress.
 */
export type MigrationStep =
	| 'connect' // no account connected yet
	| 'reconnect' // connected but credentials are stale (auth_error) — re-enter first
	| 'ready' // connected, no migration running — confirm + start
	| 'importing' // worker backfilling history
	| 'indexing' // AI learning from the imported mail
	| 'completed'
	| 'failed'
	| 'cancelled';

/** The backend migration status — derived from getStatus so it can't drift. */
export type MigrationStatus = NonNullable<
	FunctionReturnType<typeof api.mail.migration.getStatus>
>['status'];

/**
 * Pure step derivation (exported for unit tests): an in-flight/finished
 * migration's status wins; otherwise it's the connect / reconnect / ready
 * pre-migration choice based on whether a mailbox is connected and whether its
 * stored credentials are still good.
 *
 * `accountStatus === 'auth_error'` means the worker won't open a connection for
 * this account (listConnectableAccounts excludes it), so a migration started now
 * would wedge at `importing` forever — and `mail.migration.start` refuses it.
 * Surface the `reconnect` step instead of a green "ready" Start button.
 */
export function deriveMigrationStep(
	status: MigrationStatus | null | undefined,
	isConnected: boolean,
	accountStatus?: string | null
): MigrationStep {
	switch (status) {
		case 'importing':
			return 'importing';
		case 'indexing':
			return 'indexing';
		case 'completed':
			return 'completed';
		case 'failed':
			return 'failed';
		case 'cancelled':
			return 'cancelled';
		default:
			if (!isConnected) return 'connect';
			return accountStatus === 'auth_error' ? 'reconnect' : 'ready';
	}
}

/**
 * When a throttle-paused import picks up again, or `null` when it is not
 * paused. The backend holds an import whose provider ran out of its daily
 * download budget at `importing` with a `resumesAt` (#760) — a wait, not a
 * failure — and clears it once the resumed walk records a batch. A resume time
 * already behind `now` means the walk is due to start again, so it no longer
 * reads as paused even before that first batch lands.
 */
export function pausedUntil(
	status: MigrationStatus | null | undefined,
	resumesAt: number | null | undefined,
	now: number
): number | null {
	if (status !== 'importing' || resumesAt === undefined || resumesAt === null) return null;
	return resumesAt > now ? resumesAt : null;
}

/**
 * The resume time as the pause copy shows it: a weekday and a clock time,
 * because a daily window reopens as often tomorrow as today.
 */
export function formatResumeTime(resumesAt: number, locale: string): string {
	return new Intl.DateTimeFormat(locale, {
		weekday: 'short',
		hour: 'numeric',
		minute: '2-digit',
	}).format(new Date(resumesAt));
}

/** How often the pause state re-checks the clock, so it lifts on time. */
const PAUSE_CLOCK_TICK_MS = 30_000;

/**
 * The pause half of a migration's progress, shared by the personal wizard and
 * the team-inbox card so the two can never disagree about it.
 */
export function useImportPause(
	migration: ComputedRef<{ status: MigrationStatus; resumesAt?: number } | null>
) {
	const { locale } = useI18n();
	const now = ref(Date.now());
	if (import.meta.client) {
		const timer = setInterval(() => {
			now.value = Date.now();
		}, PAUSE_CLOCK_TICK_MS);
		onScopeDispose(() => clearInterval(timer));
	}
	const resumesAt = computed(() =>
		pausedUntil(migration.value?.status, migration.value?.resumesAt, now.value)
	);
	const isPaused = computed(() => resumesAt.value !== null);
	const resumesAtLabel = computed(() =>
		resumesAt.value === null ? '' : formatResumeTime(resumesAt.value, locale.value)
	);
	return { isPaused, resumesAtLabel };
}

export function useMailMigration() {
	const { t } = useI18n();
	const { data: statusData } = useConvexQuery(api.mail.migration.getStatus, () => ({}));
	const { data: accountData } = useConvexQuery(
		api.mail.external.accounts.getForCurrentUser,
		() => ({})
	);

	const migration = computed(() => statusData.value ?? null);
	const account = computed(() => accountData.value ?? null);
	const isConnected = computed(() => account.value?.configured === true);
	// `getForCurrentUser` only exposes `status` on a configured account.
	const accountStatus = computed(() => (account.value?.configured ? account.value.status : null));

	const startOp = useBackendOperation(api.mail.migration.start, {
		label: () => t('shared.postbox.useMailMigration.startOperation'),
	});
	const cancelOp = useBackendOperation(api.mail.migration.cancel, {
		label: () => t('shared.postbox.useMailMigration.cancelOperation'),
	});

	const step = computed<MigrationStep>(() =>
		deriveMigrationStep(migration.value?.status, isConnected.value, accountStatus.value)
	);

	const importPercent = computed(() => migration.value?.importPercent ?? 0);
	const indexPercent = computed(() => migration.value?.indexPercent ?? 0);
	const isAiIndexing = computed(() => migration.value?.isAiIndexingEnabled === true);

	// Before the worker reports any folder counts, the total is 0 — show an
	// indeterminate "discovering your mailbox" state rather than a stuck 0%.
	const isDiscovering = computed(
		() => step.value === 'importing' && (migration.value?.messagesTotal ?? 0) === 0
	);
	const { isPaused, resumesAtLabel } = useImportPause(migration);

	async function start(source: 'google' | 'imap' = 'google') {
		return await startOp.run({ source });
	}
	async function cancel() {
		return await cancelOp.run({});
	}

	return {
		migration,
		account,
		isConnected,
		step,
		importPercent,
		indexPercent,
		isAiIndexing,
		isDiscovering,
		isPaused,
		resumesAtLabel,
		start,
		cancel,
		startBusy: startOp.isLoading,
		cancelBusy: cancelOp.isLoading,
	};
}

/**
 * The same migration lifecycle for a SHARED TEAM INBOX, keyed by mailbox.
 *
 * A team inbox is org infrastructure rather than one person's mailbox, so the
 * backend has its own owner/admin-gated trio (`mail/migrationShared`) and the
 * web side needs a second binding — but nothing about how progress READS
 * differs, so the step derivation and the percent/discovering helpers above are
 * shared verbatim and can never drift between the personal wizard and the admin
 * card.
 *
 * Two deliberate differences from {@link useMailMigration}:
 *   - `connect` is unreachable: a team inbox only exists once its connection
 *     does, so the pre-migration step is `ready` (or `reconnect` when the stored
 *     credentials went stale);
 *   - knowledge indexing is OPT-IN — `start({ indexKnowledge })` — because
 *     indexing a team's mail history into the org-wide knowledge graph is a
 *     privacy and cost decision, not a default.
 */
export function useSharedMailMigration(mailboxId: MaybeRefOrGetter<Id<'mailboxes'>>) {
	const { t } = useI18n();
	const { data: statusData, isLoading: statusLoading } = useConvexQuery(
		api.mail.migrationShared.getStatusShared,
		() => ({ mailboxId: toValue(mailboxId) })
	);
	const { data: accountData, isLoading: accountLoading } = useConvexQuery(
		api.mail.external.sharedInbox.getSharedExternalAccount,
		() => ({ mailboxId: toValue(mailboxId) })
	);

	// Until BOTH subscriptions have delivered a first value, `step` is only the
	// default of its derivation — indistinguishable from a genuine "nothing is
	// running here". A card that renders that would flash a Start button at an
	// inbox whose import is already half done, so it renders a loading state
	// instead. (`null` IS a value here: an inbox that never imported reports it.)
	const isLoading = computed(() => statusLoading.value || accountLoading.value);

	const migration = computed(() => statusData.value ?? null);
	const account = computed(() => accountData.value ?? null);
	const isConnected = computed(() => account.value?.configured === true);
	const accountStatus = computed(() => (account.value?.configured ? account.value.status : null));

	// Gmail gets the 'google' backfill path, every other host the generic one —
	// the same mapping the personal wizard makes from its picked provider.
	const source = computed<'google' | 'imap'>(() =>
		account.value?.configured && account.value.imapHost.toLowerCase().includes('gmail')
			? 'google'
			: 'imap'
	);

	const startOp = useBackendOperation(api.mail.migrationShared.startShared, {
		label: () => t('shared.postbox.useMailMigration.startSharedOperation'),
	});
	const cancelOp = useBackendOperation(api.mail.migrationShared.cancelShared, {
		label: () => t('shared.postbox.useMailMigration.cancelSharedOperation'),
	});

	const step = computed<MigrationStep>(() =>
		deriveMigrationStep(migration.value?.status, isConnected.value, accountStatus.value)
	);

	const importPercent = computed(() => migration.value?.importPercent ?? 0);
	const indexPercent = computed(() => migration.value?.indexPercent ?? 0);
	const isAiIndexing = computed(() => migration.value?.isAiIndexingEnabled === true);
	const isDiscovering = computed(
		() => step.value === 'importing' && (migration.value?.messagesTotal ?? 0) === 0
	);
	const { isPaused, resumesAtLabel } = useImportPause(migration);

	async function start(options?: { indexKnowledge?: boolean }) {
		return await startOp.run({
			mailboxId: toValue(mailboxId),
			source: source.value,
			indexKnowledge: options?.indexKnowledge === true,
		});
	}
	async function cancel() {
		return await cancelOp.run({ mailboxId: toValue(mailboxId) });
	}

	return {
		migration,
		account,
		isConnected,
		isLoading,
		step,
		importPercent,
		indexPercent,
		isAiIndexing,
		isDiscovering,
		isPaused,
		resumesAtLabel,
		start,
		cancel,
		startBusy: startOp.isLoading,
		cancelBusy: cancelOp.isLoading,
	};
}
