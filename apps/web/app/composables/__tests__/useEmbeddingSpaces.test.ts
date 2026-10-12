/**
 * The embedding section's operations: each control calls its endpoint with
 * the right arguments and says so when it lands, one busy flag covers them
 * all, a validation is kept for its staged space only, and an activation the
 * server refuses for failing validation is shown as that validation instead
 * of a toast.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref, type Ref } from 'vue';
import type { OperationError } from '@owlat/shared/operationError';
import { createTestI18n } from '~/__tests__/i18n';
import { embeddingStatus, job, space } from '~/utils/__tests__/embeddingStatusFixtures';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

const { useEmbeddingSpaces } = await import('../useEmbeddingSpaces');

type Call = { label: string; args: unknown };
let calls: Call[];
let status: Ref<unknown>;
/** Per label: what `run` answers, or a refusal handed to `onError`. */
let answers: Record<string, { result?: unknown; refusal?: OperationError }>;
const loading: Record<string, Ref<boolean>> = {};
const showToast = vi.fn();

beforeEach(() => {
	const i18n = createTestI18n();
	vi.stubGlobal('useI18n', () => i18n.global);
	vi.stubGlobal('useToast', () => ({ showToast }));
	showToast.mockReset();
	calls = [];
	answers = {};
	status = ref(embeddingStatus());
	vi.stubGlobal('useOrganizationQuery', () => ({
		data: status,
		isLoading: ref(false),
		error: ref(null),
		refetch: vi.fn(),
	}));
	vi.stubGlobal(
		'useBackendOperation',
		(
			_ref: unknown,
			options: { label: () => string; onError?: (op: OperationError) => boolean }
		) => {
			const label = options.label();
			loading[label] = ref(false);
			return {
				isLoading: loading[label],
				run: vi.fn(async (args: unknown) => {
					calls.push({ label, args });
					const answer = answers[label];
					if (answer?.refusal) {
						options.onError?.(answer.refusal);
						return { ok: false };
					}
					return { ok: true, result: answer?.result ?? null };
				}),
			};
		}
	);
});

describe('useEmbeddingSpaces', () => {
	it('runs each control against its endpoint and toasts when it lands', async () => {
		const spaces = useEmbeddingSpaces();
		const running = job();
		await spaces.refresh();
		await spaces.startReembed();
		await spaces.resume(running);
		await spaces.cancel(running);
		await spaces.revoke('att_1' as never);
		await spaces.startRebuild({
			embeddingProviderKind: 'openai',
			embeddingModel: 'text-embedding-3-large',
		});
		await spaces.catchUp();
		await spaces.cancelRebuild();
		await spaces.rollback();
		expect(calls).toEqual([
			{ label: 'Count embedding coverage', args: {} },
			{ label: 'Start re-embedding', args: {} },
			{ label: 'Resume re-embedding', args: { jobId: 'job_1' } },
			{ label: 'Cancel re-embedding', args: { jobId: 'job_1' } },
			{ label: 'Revoke attestation', args: { attestationId: 'att_1' } },
			{
				label: 'Start rebuild',
				args: { embeddingProviderKind: 'openai', embeddingModel: 'text-embedding-3-large' },
			},
			{ label: 'Embed changes into the rebuild', args: {} },
			{ label: 'Cancel rebuild', args: {} },
			{ label: 'Roll back the embedding model', args: {} },
		]);
		expect(showToast).toHaveBeenCalledTimes(9);
		expect(showToast).toHaveBeenCalledWith('Re-embedding started.');
	});

	it('is busy while any control runs', () => {
		const spaces = useEmbeddingSpaces();
		expect(spaces.isBusy.value).toBe(false);
		loading['Activate rebuild']!.value = true;
		expect(spaces.isBusy.value).toBe(true);
	});

	it('keeps a validation for its staged space only', async () => {
		status.value = embeddingStatus({
			staged: space({ _id: 'sp_staged' as never, state: 'staged' }),
		});
		answers['Validate rebuild'] = {
			result: { spaceId: 'sp_staged', sampled: 5, passed: 5, isPassing: true },
		};
		const spaces = useEmbeddingSpaces();
		expect(await spaces.validate()).toBe(true);
		expect(spaces.validation.value?.isPassing).toBe(true);
		status.value = embeddingStatus({ staged: null });
		await nextTick();
		expect(spaces.validation.value).toBeNull();
	});

	it('shows a refused activation as the failed validation, with no toast', async () => {
		answers['Activate rebuild'] = {
			refusal: {
				category: 'invalid_state',
				message: 'The staged embedding space failed validation: 2 of 5…',
				data: { spaceId: 'sp_staged', sampled: 5, passed: 2, isPassing: false },
			},
		};
		const spaces = useEmbeddingSpaces();
		expect(await spaces.activate()).toBe(false);
		expect(spaces.validation.value).toEqual({
			spaceId: 'sp_staged',
			sampled: 5,
			passed: 2,
			isPassing: false,
		});
		expect(showToast).not.toHaveBeenCalled();
	});

	it('leaves other activation refusals to the operation layer', async () => {
		answers['Activate rebuild'] = {
			refusal: { category: 'invalid_state', message: 'Rows changed since the rebuild started.' },
		};
		const spaces = useEmbeddingSpaces();
		expect(await spaces.activate()).toBe(false);
		expect(spaces.validation.value).toBeNull();
	});

	it('records an attestation with the arguments it is given', async () => {
		const spaces = useEmbeddingSpaces();
		const args = {
			spaceId: 'sp_active' as never,
			source: 'attestation' as const,
			cohort: { tables: ['knowledgeEntries' as const], writtenUntil: 1 },
			statement: 'Used since setup.',
		};
		expect(await spaces.attest(args)).toBe(true);
		expect(calls).toEqual([{ label: 'Record attestation', args }]);
	});
});
