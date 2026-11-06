/**
 * The client half of moving mail to another mailbox: which mailboxes are
 * offered, the one-time team inbox confirmation, the rows a move hides and
 * brings back, the undo (move the copies back, or purge them), and the wording
 * while copies are still on their way to a connected account's provider.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import type { Id } from '@owlat/api/dataModel';
import { createTestI18n } from '~/__tests__/i18n';

const hidden = new Set<string>();
vi.mock('../usePostboxOptimisticHide', () => ({
	hidePostboxRowEverywhere: (id: string) => hidden.add(id),
	unhidePostboxRowEverywhere: (id: string) => hidden.delete(id),
}));

const { t } = createTestI18n().global;
vi.stubGlobal('useI18n', () => ({ t }));
const showToast = vi.fn();
vi.stubGlobal('useToast', () => ({ showToast }));
const confirm = vi.fn(async () => true);
vi.stubGlobal('useConfirm', () => confirm);
const register = vi.fn();
vi.stubGlobal('usePostboxTriageUndo', () => ({ register }));
const inboxes = ref([
	{ mailboxId: 'mine', name: 'Ada', scope: 'personal' },
	{ mailboxId: 'team', name: 'Support', scope: 'shared' },
	{ mailboxId: 'gmail', name: 'Gmail', scope: 'personal', isConnected: true },
]);
vi.stubGlobal('useInboxes', () => ({ inboxes }));
const stored = ref<string[]>([]);
vi.stubGlobal('useLocalStorage', () => ({
	data: stored,
	set: (value: string[]) => (stored.value = value),
}));

type Run = (args: Record<string, unknown>) => Promise<unknown>;
const transferRun = vi.fn<Run>();
const purgeRun = vi.fn<Run>(async () => ({ ok: true, result: { ok: true } }));
vi.stubGlobal('useBackendOperation', (operation: unknown) => ({
	run: String(operation).includes('purge') ? purgeRun : transferRun,
}));
vi.mock('@owlat/api', () => ({
	api: {
		mail: {
			mailboxTransfer: { transfer: 'mail/mailboxTransfer:transfer' },
			messageActions: { purge: 'mail/messageActions:purge' },
		},
	},
}));

const { usePostboxMailboxTransfer } = await import('../usePostboxMailboxTransfer');

const id = (value: string) => value as Id<'mailMessages'>;
const folder = (value: string) => value as Id<'mailFolders'>;

beforeEach(() => {
	hidden.clear();
	stored.value = [];
	vi.clearAllMocks();
});

describe('usePostboxMailboxTransfer', () => {
	it('offers every other mailbox and marks the connected ones', () => {
		const transfer = usePostboxMailboxTransfer(() => 'mine');
		expect(transfer.targets.value.map((m) => [m.mailboxId, m.isShared, m.isConnected])).toEqual([
			['team', true, false],
			['gmail', false, true],
		]);
	});

	it('asks once before filing into a team inbox, and never for a personal one', async () => {
		const transfer = usePostboxMailboxTransfer(() => 'gmail');
		expect(await transfer.confirmTarget('mine' as Id<'mailboxes'>)).toBe(true);
		expect(confirm).not.toHaveBeenCalled();
		expect(await transfer.confirmTarget('team' as Id<'mailboxes'>)).toBe(true);
		expect(await transfer.confirmTarget('team' as Id<'mailboxes'>)).toBe(true);
		expect(confirm).toHaveBeenCalledTimes(1);
	});

	it('does not remember a declined confirmation', async () => {
		confirm.mockResolvedValueOnce(false);
		const transfer = usePostboxMailboxTransfer(() => 'mine');
		expect(await transfer.confirmTarget('team' as Id<'mailboxes'>)).toBe(false);
		expect(stored.value).toEqual([]);
	});

	it('moves, brings back what the target already held, and undoes by moving back', async () => {
		transferRun.mockResolvedValueOnce({
			ok: true,
			result: {
				ok: true,
				moved: [{ messageId: id('copy-a'), sourceFolderId: folder('inbox') }],
				skipped: [id('b')],
			},
		});
		const transfer = usePostboxMailboxTransfer(() => 'mine');

		expect(await transfer.transfer([id('a'), id('b')], 'team' as Id<'mailboxes'>, 'move')).toBe(
			true
		);

		expect(transferRun).toHaveBeenCalledWith({
			messageIds: ['a', 'b'],
			targetMailboxId: 'team',
			mode: 'move',
		});
		expect([...hidden]).toEqual(['a']);
		expect(showToast).toHaveBeenCalledWith(expect.stringContaining('Support'), 'info');
		const [{ label, inverse }] = register.mock.calls[0]!;
		expect(label).toBe('Moved to Support');

		transferRun.mockResolvedValueOnce({ ok: true, result: { ok: true, moved: [], skipped: [] } });
		await inverse();
		expect(transferRun).toHaveBeenLastCalledWith({
			messageIds: ['copy-a'],
			targetMailboxId: 'mine',
			targetFolderId: 'inbox',
			mode: 'move',
		});
		expect(hidden.size).toBe(0);
	});

	it('restores every row when the server refuses', async () => {
		transferRun.mockResolvedValueOnce({ ok: false });
		const transfer = usePostboxMailboxTransfer(() => 'mine');

		expect(await transfer.transfer([id('a')], 'team' as Id<'mailboxes'>, 'move')).toBe(false);

		expect(hidden.size).toBe(0);
		expect(register).not.toHaveBeenCalled();
	});

	it('sends a long selection in bounded calls', async () => {
		transferRun.mockImplementation(async (args) => ({
			ok: true,
			result: { ok: true, moved: [], skipped: [], args },
		}));
		const transfer = usePostboxMailboxTransfer(() => 'mine');
		const ids = Array.from({ length: 30 }, (_, i) => id(`m${i}`));

		await transfer.transfer(ids, 'team' as Id<'mailboxes'>, 'copy');

		expect(transferRun.mock.calls.map(([args]) => (args['messageIds'] as string[]).length)).toEqual(
			[25, 5]
		);
		transferRun.mockReset();
	});

	it('copies without hiding the source, and undoes by purging the copies', async () => {
		transferRun.mockResolvedValueOnce({
			ok: true,
			result: {
				ok: true,
				moved: [{ messageId: id('copy-a'), sourceFolderId: folder('inbox') }],
				skipped: [],
			},
		});
		const transfer = usePostboxMailboxTransfer(() => 'mine');

		await transfer.transfer([id('a')], 'team' as Id<'mailboxes'>, 'copy');

		expect(hidden.size).toBe(0);
		const [{ label, inverse }] = register.mock.calls[0]!;
		expect(label).toBe('Copied to Support');
		await inverse();
		expect(purgeRun).toHaveBeenCalledWith({ messageIds: ['copy-a'] });
	});

	it('moves into a connected account, says it is under way, and undoes by moving back', async () => {
		transferRun.mockResolvedValueOnce({
			ok: true,
			result: {
				ok: true,
				moved: [
					{ messageId: id('copy-a'), sourceFolderId: folder('inbox') },
					{ messageId: id('copy-b'), sourceFolderId: folder('inbox') },
				],
				skipped: [],
				uploading: true,
			},
		});
		const transfer = usePostboxMailboxTransfer(() => 'mine');

		expect(await transfer.transfer([id('a'), id('b')], 'gmail' as Id<'mailboxes'>, 'move')).toBe(
			true
		);

		expect([...hidden]).toEqual(['a', 'b']);
		const [{ label, inverse }] = register.mock.calls[0]!;
		expect(label).toBe('Moving 2 messages to Gmail');

		transferRun.mockResolvedValueOnce({
			ok: true,
			result: { ok: true, moved: [], skipped: [], uploading: false },
		});
		await inverse();
		expect(transferRun).toHaveBeenLastCalledWith({
			messageIds: ['copy-a', 'copy-b'],
			targetMailboxId: 'mine',
			targetFolderId: 'inbox',
			mode: 'move',
		});
		expect(hidden.size).toBe(0);
	});

	it('words a copy into a connected account as under way', async () => {
		transferRun.mockResolvedValueOnce({
			ok: true,
			result: {
				ok: true,
				moved: [{ messageId: id('copy-a'), sourceFolderId: folder('inbox') }],
				skipped: [],
				uploading: true,
			},
		});
		const transfer = usePostboxMailboxTransfer(() => 'mine');

		await transfer.transfer([id('a')], 'gmail' as Id<'mailboxes'>, 'copy');

		expect(register.mock.calls[0]![0].label).toBe('Copying to Gmail');
	});
});
