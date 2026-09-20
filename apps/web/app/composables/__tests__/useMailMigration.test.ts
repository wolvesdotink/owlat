import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { api } from '@owlat/api';
import { getFunctionName, type FunctionReturnType } from 'convex/server';
import type { Id } from '@owlat/api/dataModel';
import { deriveMigrationStep, useSharedMailMigration } from '../postbox/useMailMigration';
import { createTestI18n } from '~/__tests__/i18n';

describe('deriveMigrationStep', () => {
	it('drives the wizard from the migration status when one exists', () => {
		expect(deriveMigrationStep('importing', true)).toBe('importing');
		expect(deriveMigrationStep('indexing', true)).toBe('indexing');
		expect(deriveMigrationStep('completed', true)).toBe('completed');
		expect(deriveMigrationStep('failed', true)).toBe('failed');
		expect(deriveMigrationStep('cancelled', true)).toBe('cancelled');
	});

	it('a migration status wins regardless of connection state', () => {
		// A migration can only exist if a mailbox was connected, but the
		// derivation must not depend on the (separately-fetched) account query.
		expect(deriveMigrationStep('importing', false)).toBe('importing');
		expect(deriveMigrationStep('completed', false)).toBe('completed');
	});

	it('falls back to connect/ready when there is no migration', () => {
		expect(deriveMigrationStep(null, false)).toBe('connect');
		expect(deriveMigrationStep(undefined, false)).toBe('connect');
		expect(deriveMigrationStep(null, true)).toBe('ready');
		expect(deriveMigrationStep(undefined, true)).toBe('ready');
	});

	it('resumes an in-flight import after the wizard is closed and reopened', () => {
		// The wizard is stateless across reloads: on reopen it reads the persisted
		// migration status and lands the user back on the live step, never on the
		// provider picker mid-import.
		expect(deriveMigrationStep('importing', true, 'connected')).toBe('importing');
		expect(deriveMigrationStep('indexing', true, 'connected')).toBe('indexing');
		// Even if the account query hasn't resolved yet on reopen, status wins.
		expect(deriveMigrationStep('importing', false)).toBe('importing');
	});

	it('steers to reconnect when the connected account is in auth_error', () => {
		// The worker won't connect an auth_error account, so a fresh migration would
		// wedge — surface a reconnect prompt instead of a green "ready" Start button.
		expect(deriveMigrationStep(null, true, 'auth_error')).toBe('reconnect');
		expect(deriveMigrationStep(undefined, true, 'auth_error')).toBe('reconnect');
		// A healthy/transient-error account is still ready (those the worker retries).
		expect(deriveMigrationStep(null, true, 'connected')).toBe('ready');
		expect(deriveMigrationStep(null, true, 'error')).toBe('ready');
		// Not connected → still 'connect' regardless of status.
		expect(deriveMigrationStep(null, false, 'auth_error')).toBe('connect');
		// A live migration's status still wins over the account status.
		expect(deriveMigrationStep('importing', true, 'auth_error')).toBe('importing');
	});
});

/**
 * The shared-inbox twin: same derivation, different backend and a different
 * default. What is worth pinning is the WIRING — every call carries the mailbox
 * it was asked about, the backfill path follows the connected host, and
 * knowledge indexing is opt-in rather than assumed (indexing a team's whole
 * history into the org knowledge graph is a decision, not a default).
 */
describe('useSharedMailMigration', () => {
	const i18n = createTestI18n();
	const MAILBOX_ID = 'mailbox_support' as Id<'mailboxes'>;

	type Status = FunctionReturnType<typeof api.mail.migrationShared.getStatusShared>;
	type Account = FunctionReturnType<typeof api.mail.external.sharedInbox.getSharedExternalAccount>;

	const status = ref<Status>(null);
	const account = ref<Account>({ configured: false });
	const runs: { name: string; args: unknown; label: string }[] = [];

	/** A migration row as `getStatusShared` projects it. */
	function migrationRow(overrides: Partial<NonNullable<Status>>): Status {
		return {
			_id: 'migration_1',
			status: 'importing',
			source: 'google',
			isAiIndexingEnabled: false,
			messagesTotal: 8300,
			messagesImported: 1204,
			messagesIndexed: 0,
			importPercent: 14,
			indexPercent: 0,
			startedAt: 1,
			importCompletedAt: undefined,
			completedAt: undefined,
			lastError: undefined,
			...overrides,
		} as Status;
	}

	/** A connected shared account, Gmail unless a host says otherwise. */
	function connected(imapHost = 'imap.gmail.com', accountStatus = 'connected'): Account {
		return {
			configured: true,
			mailboxId: MAILBOX_ID,
			emailAddress: 'support@owlat.test',
			imapHost,
			status: accountStatus,
		} as unknown as Account;
	}

	beforeEach(() => {
		status.value = null;
		account.value = connected();
		runs.length = 0;
		vi.stubGlobal('useI18n', () => i18n.global);
		vi.stubGlobal('useConvexQuery', (reference: unknown, args: () => unknown) => {
			// Calling the getter is what proves the subscription is keyed by the
			// mailbox under management rather than by "the caller's own account".
			expect(args()).toEqual({ mailboxId: MAILBOX_ID });
			// The generated `api` builds a fresh reference object on every property
			// access, so identity is not a usable key — the function PATH is.
			const data =
				getFunctionName(reference as Parameters<typeof getFunctionName>[0]) ===
				getFunctionName(api.mail.migrationShared.getStatusShared)
					? status
					: account;
			return { data, isLoading: ref(false), error: ref(null) };
		});
		vi.stubGlobal(
			'useBackendOperation',
			(
				reference: Parameters<typeof getFunctionName>[0],
				options: { label: string | (() => string) }
			) => ({
				run: async (args: unknown) => {
					const label = typeof options.label === 'function' ? options.label() : options.label;
					runs.push({ name: getFunctionName(reference), args, label });
					return { ok: true, result: { migrationId: 'migration_1', status: 'importing' } };
				},
				isLoading: ref(false),
			})
		);
	});

	// No `unstubAllGlobals` teardown on purpose: it would also drop the Vue
	// auto-import stubs the shared setup file installs (`toValue`, `computed`),
	// which this composable calls — and every stub here is re-seeded per case.

	it('starts the import for the mailbox it was given, learning off by default', async () => {
		const migration = useSharedMailMigration(() => MAILBOX_ID);

		await migration.start();

		expect(runs).toEqual([
			{
				name: 'mail/migrationShared:startShared',
				args: { mailboxId: MAILBOX_ID, source: 'google', indexKnowledge: false },
				label: 'Start team inbox import',
			},
		]);
	});

	it('passes the knowledge opt-in through, and follows the connected host', async () => {
		account.value = connected('mail.example.com');
		const migration = useSharedMailMigration(MAILBOX_ID);

		await migration.start({ indexKnowledge: true });

		expect(runs[0]!.args).toEqual({
			mailboxId: MAILBOX_ID,
			source: 'imap',
			indexKnowledge: true,
		});
	});

	it('cancels by mailbox', async () => {
		const migration = useSharedMailMigration(() => MAILBOX_ID);

		await migration.cancel();

		expect(runs).toEqual([
			{
				name: 'mail/migrationShared:cancelShared',
				args: { mailboxId: MAILBOX_ID },
				label: 'Stop team inbox import',
			},
		]);
	});

	it('reads progress off the shared status row through the same derivation', () => {
		const migration = useSharedMailMigration(() => MAILBOX_ID);
		expect(migration.step.value).toBe('ready');

		status.value = migrationRow({});
		expect(migration.step.value).toBe('importing');
		expect(migration.importPercent.value).toBe(14);
		expect(migration.isDiscovering.value).toBe(false);

		// No folder counts yet: indeterminate "discovering", not a stuck 0%.
		status.value = migrationRow({ messagesTotal: 0, messagesImported: 0, importPercent: 0 });
		expect(migration.isDiscovering.value).toBe(true);

		status.value = migrationRow({
			status: 'indexing',
			isAiIndexingEnabled: true,
			indexPercent: 40,
		});
		expect(migration.step.value).toBe('indexing');
		expect(migration.isAiIndexing.value).toBe(true);
		expect(migration.indexPercent.value).toBe(40);
	});

	it('asks for a reconnect instead of a start the worker would wedge on', () => {
		account.value = connected('imap.gmail.com', 'auth_error');
		const migration = useSharedMailMigration(() => MAILBOX_ID);
		expect(migration.step.value).toBe('reconnect');
	});
});
