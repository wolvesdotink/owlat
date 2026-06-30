import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref } from 'vue';
import { ConvexError } from 'convex/values';
import { useBackendOperation } from '../useBackendOperation';

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
		vi.stubGlobal('useConvex', () => ({ mutation, action }));
		vi.stubGlobal('useToast', () => ({ showToast }));
		vi.stubGlobal('usePostHog', () => ({ captureError }));
		vi.stubGlobal('navigateTo', navigate);
	});

	describe('success path', () => {
		it('returns the result and surfaces nothing', async () => {
			mutation.mockResolvedValue({ id: '1' });
			const { run, isLoading, inlineError } = useBackendOperation(fakeOp, { label: 'create' });

			const result = await run({ name: 'x' });

			expect(result).toEqual({ id: '1' });
			expect(mutation).toHaveBeenCalledWith(fakeOp, { name: 'x' });
			expect(showToast).not.toHaveBeenCalled();
			expect(captureError).not.toHaveBeenCalled();
			expect(isLoading.value).toBe(false);
			expect(inlineError.value).toBeNull();
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

	describe('treatment policy', () => {
		it('toasts a forbidden error with the backend message and does not report', async () => {
			mutation.mockRejectedValue(new ConvexError({ category: 'forbidden', message: 'No access' }));
			const { run } = useBackendOperation(fakeOp, { label: 'create' });

			const result = await run({});

			expect(result).toBeUndefined();
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
				'error',
			);
			expect(captureError).toHaveBeenCalledOnce();
		});

		it('redirects to login on unauthenticated', async () => {
			mutation.mockRejectedValue(
				new ConvexError({ category: 'unauthenticated', message: 'nope' }),
			);
			const { run } = useBackendOperation(fakeOp, { label: 'create' });

			await run({});

			expect(navigate).toHaveBeenCalledWith('/auth/login');
			expect(showToast).toHaveBeenCalledWith(
				expect.stringContaining('session has expired'),
				'error',
			);
			expect(captureError).not.toHaveBeenCalled();
		});
	});

	describe('inlineTarget', () => {
		it('writes inlineError on invalid_input when a target is bound (no toast)', async () => {
			mutation.mockRejectedValue(
				new ConvexError({ category: 'invalid_input', message: 'Email is invalid' }),
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
				new ConvexError({ category: 'already_exists', message: 'Already taken' }),
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

	describe('null client', () => {
		it('toasts and returns undefined without throwing', async () => {
			vi.stubGlobal('useConvex', () => null);
			const { run } = useBackendOperation(fakeOp, { label: 'create' });

			const result = await run({});

			expect(result).toBeUndefined();
			expect(showToast).toHaveBeenCalledWith('Something went wrong. Please try again.', 'error');
		});
	});
});
