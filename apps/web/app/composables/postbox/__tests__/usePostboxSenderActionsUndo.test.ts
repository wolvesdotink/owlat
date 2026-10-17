// @vitest-environment happy-dom
/**
 * Sender actions offer Undo for the operation they recorded (read on arrival
 * §4.4), on every path that recorded one: a status change, and an unsubscribe
 * whose one-click request failed (local suppression and its archive still went
 * through).
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { createTestI18n } from '~/__tests__/i18n';
import { usePostboxSenderActions } from '../usePostboxSenderActions';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, { get: () => anyPath, apply: () => anyPath });
	return { api: anyPath };
});

const i18n = createTestI18n();
const runs = new Map<string, ReturnType<typeof vi.fn>>();
const showToast = vi.fn();

beforeAll(() => {
	vi.stubGlobal('useI18n', () => i18n.global);
	vi.stubGlobal('useToast', () => ({ showToast }));
	vi.stubGlobal('usePostboxUnsubscribeOpen', () => ({ openManualUnsubscribe: vi.fn() }));
	vi.stubGlobal('useConvexQuery', () => ({ data: ref(null), isLoading: ref(false) }));
	vi.stubGlobal('useBackendOperation', (_fn: unknown, opts: { label: () => string }) => {
		const run = vi.fn(async (_args: unknown): Promise<unknown> => ({ ok: false }));
		runs.set(opts.label(), run);
		return { run, isLoading: ref(false) };
	});
	vi.stubGlobal('confirm', () => true);
	vi.stubGlobal('open', vi.fn());
});

beforeEach(() => {
	runs.clear();
	showToast.mockReset();
});

describe('usePostboxSenderActions undo', () => {
	it('offers Undo when a one-click unsubscribe failed but was suppressed locally', async () => {
		const actions = usePostboxSenderActions();
		runs.get('Unsubscribe')!.mockResolvedValue({
			ok: true,
			result: {
				scope: 'personal',
				method: 'one_click',
				result: 'failed',
				operationId: 'op1',
				archived: 3,
				address: 'news@shop.example',
			},
		});
		await actions.unsubscribe({ messageId: 'm1' as never }, { mailboxId: 'mb1', name: 'Shop' });
		expect(showToast).toHaveBeenCalledWith(
			"Couldn't unsubscribe; mail from them is archived",
			'error',
			expect.objectContaining({ action: expect.objectContaining({ label: 'Undo' }) })
		);
	});

	it('offers Undo for a status change', async () => {
		const actions = usePostboxSenderActions();
		runs.get('Change sender')!.mockResolvedValue({
			ok: true,
			result: { operationId: 'op2', archived: 0, address: 'news@shop.example' },
		});
		await actions.setStatus({ messageId: 'm1' as never }, 'digest', 'Shop');
		expect(showToast).toHaveBeenCalledWith(
			'Mail from Shop now goes to your digest',
			'success',
			expect.objectContaining({ action: expect.objectContaining({ label: 'Undo' }) })
		);
	});
});
