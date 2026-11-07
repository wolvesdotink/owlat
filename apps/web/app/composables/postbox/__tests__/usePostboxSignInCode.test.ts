/**
 * The shared "use this sign-in code" helper behind the chip, the reader's `y`,
 * the palette and the notification actions, and the reader's handling of a web
 * push's copy request.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, reactive, ref } from 'vue';
import { createTestI18n } from '~/__tests__/i18n';
import {
	latestLiveSignInCode,
	usePostboxSignInCode,
	usePostboxSignInCodeIntent,
} from '../usePostboxSignInCode';

const { t } = createTestI18n().global;
const NOW = Date.UTC(2026, 10, 2, 12);
const showToast = vi.fn();

const code = (value: string, expiresAt = NOW + 60_000) => ({
	kind: 'code' as const,
	value,
	senderDomain: 'northwind.example',
	expiresAt,
});

beforeEach(() => {
	vi.setSystemTime(NOW);
	vi.stubGlobal('useI18n', () => ({ t }));
	vi.stubGlobal('useToast', () => ({ showToast }));
});

afterEach(() => {
	vi.useRealTimers();
	showToast.mockReset();
});

describe('latestLiveSignInCode', () => {
	it('takes the newest message whose code is still live', () => {
		const messages = [
			{ signInCode: code('111111') },
			{ signInCode: code('222222') },
			{ signInCode: code('333333', NOW) },
			{},
		];
		expect(latestLiveSignInCode(messages)?.value).toBe('222222');
		expect(latestLiveSignInCode([{ signInCode: code('333333', NOW) }])).toBeNull();
	});
});

describe('copyOrOpen', () => {
	it('copies a live code and says so', async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		vi.stubGlobal('navigator', { clipboard: { writeText } });

		await usePostboxSignInCode().copyOrOpen(code('482913'));

		expect(writeText).toHaveBeenCalledWith('482913');
		expect(showToast).toHaveBeenCalledWith('Code copied');
	});

	it('keeps a Copy button when the browser refuses the clipboard, and that button copies', async () => {
		const writeText = vi
			.fn()
			.mockRejectedValueOnce(new DOMException('Document is not focused.', 'NotAllowedError'))
			.mockResolvedValue(undefined);
		vi.stubGlobal('navigator', { clipboard: { writeText } });

		await usePostboxSignInCode().copyOrOpen(code('482913'));

		const [message, kind, options] = showToast.mock.calls[0] as [
			string,
			string,
			{ durationMs: number; action: { label: string; onAction: () => void } },
		];
		expect([message, kind, options.durationMs, options.action.label]).toEqual([
			"Couldn't copy the code",
			'error',
			0,
			'Copy',
		]);
		options.action.onAction();
		await vi.waitFor(() => expect(showToast).toHaveBeenLastCalledWith('Code copied'));
		expect(writeText).toHaveBeenCalledTimes(2);
	});

	it('copies nothing once the code expired', async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		vi.stubGlobal('navigator', { clipboard: { writeText } });

		await usePostboxSignInCode().copyOrOpen(code('482913', NOW));
		await usePostboxSignInCode().copyOrOpen(undefined);

		expect(writeText).not.toHaveBeenCalled();
		expect(showToast.mock.calls.map(([message]) => message)).toEqual([
			t('components.postbox.postboxSignInCodeChip.unavailable'),
			t('components.postbox.postboxSignInCodeChip.unavailable'),
		]);
	});
});

describe('usePostboxSignInCodeIntent', () => {
	function setup(query: Record<string, string>, opts: { topmost?: boolean; path?: string } = {}) {
		const route = reactive({ path: opts.path ?? '/dashboard/postbox/inbox/m1', query });
		const replace = vi.fn((to: { query: Record<string, string> }) => {
			route.query = to.query;
		});
		vi.stubGlobal('useRoute', () => route);
		vi.stubGlobal('useRouter', () => ({ replace }));
		const topmost = ref(opts.topmost ?? true);
		const run = vi.fn();
		usePostboxSignInCodeIntent({
			messageId: () => 'm1',
			isTopmost: () => topmost.value,
			run,
		});
		return { route, replace, run, topmost };
	}

	it('copies once and drops the request from the route, keeping the rest', async () => {
		const { replace, run } = setup({ mailbox: 'b1', signInCode: 'copy' });
		await nextTick();

		expect(run).toHaveBeenCalledTimes(1);
		expect(replace).toHaveBeenCalledWith({ query: { mailbox: 'b1' } });
	});

	it('waits until the reader is the one on top', async () => {
		const { run, topmost } = setup({ signInCode: 'copy' }, { topmost: false });
		await nextTick();
		expect(run).not.toHaveBeenCalled();

		topmost.value = true;
		await nextTick();
		expect(run).toHaveBeenCalledTimes(1);
	});

	it('ignores a request for another message and a route without one', async () => {
		const other = setup({ signInCode: 'copy' }, { path: '/dashboard/postbox/inbox/m2' });
		const plain = setup({ mailbox: 'b1' });
		await nextTick();

		expect(other.run).not.toHaveBeenCalled();
		expect(plain.run).not.toHaveBeenCalled();
		expect(plain.replace).not.toHaveBeenCalled();
	});
});
