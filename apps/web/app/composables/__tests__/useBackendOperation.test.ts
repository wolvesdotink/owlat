import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref } from 'vue';
import { ConvexError } from 'convex/values';
import { useAnnounce } from '../useAnnounce';
import { useBackendOperation } from '../useBackendOperation';
import { createTestI18n } from '~/__tests__/i18n';

/** The real catalog behind the `useI18n` auto-import the composable calls. */
const i18n = createTestI18n();

const fakeOp = 'api.test.create' as unknown as Parameters<typeof useBackendOperation>[0];

describe('useBackendOperation', () => {
	let mutation: ReturnType<typeof vi.fn>;
	let action: ReturnType<typeof vi.fn>;
	let showToast: ReturnType<typeof vi.fn>;
	let captureError: ReturnType<typeof vi.fn>;
	let navigate: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		mutation = vi.fn();
		action = vi.fn();
		showToast = vi.fn();
		captureError = vi.fn();
		navigate = vi.fn();
		vi.stubGlobal('useI18n', () => i18n.global);
		vi.stubGlobal('useConvex', () => ({ mutation, action }));
		vi.stubGlobal('useToast', () => ({ showToast }));
		vi.stubGlobal('usePostHog', () => ({ captureError }));
		vi.stubGlobal('navigateTo', navigate);
		// The REAL announcer: what a successful write says into the live region
		// is behaviour this composable owns, and a spy would only prove it called
		// something.
		vi.stubGlobal('useAnnounce', useAnnounce);
		useAnnounce().clear();
	});

	describe('success path', () => {
		it('returns an ok envelope around the result and surfaces nothing', async () => {
			mutation.mockResolvedValue({ id: '1' });
			const { run, isLoading, inlineError } = useBackendOperation(fakeOp, { label: 'create' });

			const result = await run({ name: 'x' });

			expect(result).toEqual({ ok: true, result: { id: '1' } });
			expect(mutation).toHaveBeenCalledWith(fakeOp, { name: 'x' });
			expect(showToast).not.toHaveBeenCalled();
			expect(captureError).not.toHaveBeenCalled();
			expect(isLoading.value).toBe(false);
			expect(inlineError.value).toBeNull();
		});

		it('tells a successful `undefined` return apart from a failure', async () => {
			// The reason `run` hands back an envelope at all: plenty of mutations
			// resolve `undefined`/`null` on a perfectly good write, and the old
			// `T | undefined` signature made that indistinguishable from "failed".
			mutation.mockResolvedValue(undefined);
			const { run } = useBackendOperation(fakeOp, { label: 'create' });

			expect(await run({})).toEqual({ ok: true, result: undefined });
			expect(showToast).not.toHaveBeenCalled();
		});

		it('toggles isLoading during the call', async () => {
			let resolve!: (v: unknown) => void;
			mutation.mockReturnValue(new Promise((r) => (resolve = r)));
			const { run, isLoading } = useBackendOperation(fakeOp, { label: 'create' });

			const p = run({});
			expect(isLoading.value).toBe(true);
			resolve({ ok: true });
			await p;
			expect(isLoading.value).toBe(false);
		});

		it('dispatches to client.action when type is action', async () => {
			action.mockResolvedValue('done');
			const { run } = useBackendOperation(fakeOp, { label: 'send', type: 'action' });

			await run({});

			expect(action).toHaveBeenCalledOnce();
			expect(mutation).not.toHaveBeenCalled();
		});
	});

	/**
	 * Most of this app's saves repaint nothing louder than a button label, so
	 * without this a screen-reader user gets no confirmation that a write landed
	 * at all. Announcing HERE rather than at the call sites is the point: this is
	 * the one place every successful mutation in the app passes through.
	 */
	describe('announcement', () => {
		it('announces a completed write with the operation label', async () => {
			mutation.mockResolvedValue(null);
			const { run } = useBackendOperation(fakeOp, { label: 'Save signature' });

			await run({});

			expect(useAnnounce().politeMessage.value).toBe('Done: Save signature');
		});

		it('calls a getter label at announcement time, not at setup time', async () => {
			mutation.mockResolvedValue(null);
			let label = 'Save signature';
			const { run } = useBackendOperation(fakeOp, { label: () => label });

			label = 'Save snippet';
			await run({});

			expect(useAnnounce().politeMessage.value).toBe('Done: Save snippet');
		});

		it('re-announces an identical save so the second one is not silent', async () => {
			mutation.mockResolvedValue(null);
			const { run } = useBackendOperation(fakeOp, { label: 'Save signature' });

			await run({});
			const first = useAnnounce().politeMessage.value;
			await run({});

			// Same words, different DOM text — a live region only speaks on change.
			expect(useAnnounce().politeMessage.value).not.toBe(first);
			expect(useAnnounce().politeMessage.value.trim()).toBe('Done: Save signature');
		});

		it('stays quiet when the caller opts out', async () => {
			mutation.mockResolvedValue(null);
			const { run } = useBackendOperation(fakeOp, { label: 'Autosave draft', announce: false });

			await run({});

			expect(useAnnounce().politeMessage.value).toBe('');
		});

		it('says nothing on a failure — the toast already does, assertively', async () => {
			mutation.mockRejectedValue(new ConvexError({ category: 'forbidden', message: 'No access' }));
			const { run } = useBackendOperation(fakeOp, { label: 'Save signature' });

			await run({});

			expect(showToast).toHaveBeenCalled();
			expect(useAnnounce().politeMessage.value).toBe('');
		});
	});

	describe('treatment policy', () => {
		it('toasts a forbidden error with the backend message and does not report', async () => {
			mutation.mockRejectedValue(new ConvexError({ category: 'forbidden', message: 'No access' }));
			const { run } = useBackendOperation(fakeOp, { label: 'create' });

			const result = await run({});

			expect(result).toEqual({ ok: false });
			expect(showToast).toHaveBeenCalledWith('No access', 'error');
			expect(captureError).not.toHaveBeenCalled();
			expect(navigate).not.toHaveBeenCalled();
		});

		it('toasts generic copy and reports for an internal (non-Operation) throw', async () => {
			mutation.mockRejectedValue(new Error('TypeError: boom'));
			const { run } = useBackendOperation(fakeOp, { label: 'create' });

			await run({});

			expect(showToast).toHaveBeenCalledWith('Something went wrong. Please try again.', 'error');
			expect(captureError).toHaveBeenCalledOnce();
		});

		it('toasts and reports for a network (transport) failure', async () => {
			mutation.mockRejectedValue(new TypeError('Failed to fetch'));
			const { run } = useBackendOperation(fakeOp, { label: 'create' });

			await run({});

			expect(showToast).toHaveBeenCalledWith(
				expect.stringContaining('Connection problem'),
				'error'
			);
			expect(captureError).toHaveBeenCalledOnce();
		});

		it('redirects to login on unauthenticated', async () => {
			mutation.mockRejectedValue(new ConvexError({ category: 'unauthenticated', message: 'nope' }));
			const { run } = useBackendOperation(fakeOp, { label: 'create' });

			await run({});

			expect(navigate).toHaveBeenCalledWith('/auth/login');
			expect(showToast).toHaveBeenCalledWith(
				expect.stringContaining('session has expired'),
				'error'
			);
			expect(captureError).not.toHaveBeenCalled();
		});
	});

	describe('inlineTarget', () => {
		it('writes inlineError on invalid_input when a target is bound (no toast)', async () => {
			mutation.mockRejectedValue(
				new ConvexError({ category: 'invalid_input', message: 'Email is invalid' })
			);
			const target = ref<string | null>(null);
			const { run, inlineError } = useBackendOperation(fakeOp, {
				label: 'create',
				inlineTarget: target,
			});

			await run({});

			expect(target.value).toBe('Email is invalid');
			expect(inlineError.value).toBe('Email is invalid');
			expect(showToast).not.toHaveBeenCalled();
		});

		it('falls back to a toast on invalid_input when no target is bound', async () => {
			mutation.mockRejectedValue(
				new ConvexError({ category: 'already_exists', message: 'Already taken' })
			);
			const { run, inlineError } = useBackendOperation(fakeOp, { label: 'create' });

			await run({});

			expect(showToast).toHaveBeenCalledWith('Already taken', 'error');
			expect(inlineError.value).toBeNull();
		});

		it('clears a previous inline error at the start of each run', async () => {
			const target = ref<string | null>('stale');
			mutation.mockResolvedValue({ ok: true });
			const { run } = useBackendOperation(fakeOp, { label: 'create', inlineTarget: target });

			await run({});

			expect(target.value).toBeNull();
		});
	});

	describe('onError claim', () => {
		it('suppresses the default surface when the caller claims the failure', async () => {
			mutation.mockRejectedValue(
				new ConvexError({
					category: 'invalid_state',
					message: 'This campaign is larger than your sending capacity allows in one go.',
					data: { reason: 'exceeds_sending_capacity', capacityPlan: { days: 5 } },
				})
			);
			const seen: unknown[] = [];
			const { run } = useBackendOperation(fakeOp, {
				label: 'send',
				onError: (op) => {
					seen.push(op.data);
					return true;
				},
			});

			const result = await run({});

			expect(result).toEqual({ ok: false });
			expect(seen).toEqual([{ reason: 'exceeds_sending_capacity', capacityPlan: { days: 5 } }]);
			expect(showToast).not.toHaveBeenCalled();
			expect(captureError).not.toHaveBeenCalled();
		});

		it('falls through to the normal treatment when the caller declines', async () => {
			mutation.mockRejectedValue(
				new ConvexError({ category: 'invalid_state', message: 'No template' })
			);
			const { run } = useBackendOperation(fakeOp, {
				label: 'send',
				onError: () => false,
			});

			await run({});

			expect(showToast).toHaveBeenCalledWith('No template', 'error');
		});

		it('does not suppress reporting on a genuine fault the caller declines', async () => {
			mutation.mockRejectedValue(new Error('kaboom'));
			const { run } = useBackendOperation(fakeOp, { label: 'send', onError: () => false });

			await run({});

			expect(captureError).toHaveBeenCalledOnce();
		});
	});

	describe('null client', () => {
		it('toasts and returns a failure envelope without throwing', async () => {
			vi.stubGlobal('useConvex', () => null);
			const { run } = useBackendOperation(fakeOp, { label: 'create' });

			const result = await run({});

			expect(result).toEqual({ ok: false });
			expect(showToast).toHaveBeenCalledWith('Something went wrong. Please try again.', 'error');
		});
	});
});
