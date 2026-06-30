import { api } from '@owlat/api';
import type { FunctionReturnType } from 'convex/server';

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
	accountStatus?: string | null,
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

export function useMailMigration() {
	const { data: statusData } = useConvexQuery(api.mail.migration.getStatus, () => ({}));
	const { data: accountData } = useConvexQuery(
		api.mail.externalAccounts.getForCurrentUser,
		() => ({}),
	);

	const migration = computed(() => statusData.value ?? null);
	const account = computed(() => accountData.value ?? null);
	const isConnected = computed(() => account.value?.configured === true);
	// `getForCurrentUser` only exposes `status` on a configured account.
	const accountStatus = computed(() =>
		account.value?.configured ? account.value.status : null,
	);

	const startOp = useBackendOperation(api.mail.migration.start, { label: 'Start mailbox migration' });
	const cancelOp = useBackendOperation(api.mail.migration.cancel, {
		label: 'Cancel mailbox migration',
	});

	const step = computed<MigrationStep>(() =>
		deriveMigrationStep(migration.value?.status, isConnected.value, accountStatus.value),
	);

	const importPercent = computed(() => migration.value?.importPercent ?? 0);
	const indexPercent = computed(() => migration.value?.indexPercent ?? 0);
	const isAiIndexing = computed(() => migration.value?.isAiIndexingEnabled === true);

	// Before the worker reports any folder counts, the total is 0 — show an
	// indeterminate "discovering your mailbox" state rather than a stuck 0%.
	const isDiscovering = computed(
		() => step.value === 'importing' && (migration.value?.messagesTotal ?? 0) === 0,
	);

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
		start,
		cancel,
		startBusy: startOp.isLoading,
		cancelBusy: cancelOp.isLoading,
	};
}
