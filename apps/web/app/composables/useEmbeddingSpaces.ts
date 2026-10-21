/**
 * The embedding section of the AI provider page: the
 * admin read `aiRouting.embeddingSpaces.status` and the embed lane's admin
 * controls, each a backend operation with its own busy flag.
 *
 * What it adds over the raw calls:
 *  - one `isBusy` for the whole section, so two controls never race;
 *  - the last validation of a staged rebuild, kept until the staged space
 *    changes. `activateStaged` validates again on the server and refuses a
 *    failing space with the counts in `data`; that refusal is claimed and
 *    shown as the validation it is, not as a toast.
 *
 * Every control that acts on "the staged / searchable / previous space" names
 * the space the admin confirmed (`expectedSpaceId`); the server refuses with
 * `embedding_target_changed` when it moved meanwhile, and that refusal is
 * shown on the card (`isTargetChanged`) instead of as a toast.
 *
 * The rules a component reads (coverage, job state, blockers, the
 * attestation subject) are `utils/embeddingSpaces.ts`.
 */
import { computed, ref, watch } from 'vue';
import type { FunctionArgs, FunctionReturnType } from 'convex/server';
import { api } from '@owlat/api';
import type { OperationError } from '@owlat/shared/operationError';
import type { EmbeddingJob } from '~/utils/embeddingSpaces';

export type RebuildValidation = FunctionReturnType<
	typeof api.aiRouting.embeddingRebuild.validateStaged
>;
export type AttestArgs = FunctionArgs<typeof api.aiRouting.embeddingAttestations.attest>;
type RevokeArgs = FunctionArgs<typeof api.aiRouting.embeddingAttestations.revoke>;
export type RebuildTarget = FunctionArgs<typeof api.aiRouting.embeddingRebuild.startRebuild>;

const K = 'dashboard.admin.instance.aiProvider.embeddingSpace';

type SpaceId = NonNullable<
	FunctionArgs<typeof api.aiRouting.embeddingRebuild.validateStaged>['expectedSpaceId']
>;

/** The guard's refusal: the space the admin confirmed is no longer the one acted on. */
function isTargetChangedRefusal(op: OperationError): boolean {
	return op.category === 'conflict' && op.data?.['reason'] === 'embedding_target_changed';
}

/** A refused activation's counts, when the refusal carries them. */
function failedValidationOf(op: OperationError): RebuildValidation | null {
	const data = op.data;
	if (op.category !== 'invalid_state' || !data) return null;
	const { spaceId, sampled, passed } = data;
	if (typeof sampled !== 'number' || typeof passed !== 'number' || typeof spaceId !== 'string') {
		return null;
	}
	return { spaceId: spaceId as RebuildValidation['spaceId'], sampled, passed, isPassing: false };
}

export function useEmbeddingSpaces() {
	const { t } = useI18n();
	const { showToast } = useToast();

	const {
		data: status,
		isLoading,
		error,
		refetch,
	} = useOrganizationQuery(api.aiRouting.embeddingSpaces.status);

	const label = (key: string) => () => t(`${K}.operations.${key}`);
	/**
	 * Set when the server refused because the space the admin confirmed is no
	 * longer the one it would act on (another admin changed it meanwhile).
	 * Shown on the card, not as a toast; the next control clears it.
	 */
	const isTargetChanged = ref(false);
	const claimTargetChanged = (op: OperationError) => {
		if (!isTargetChangedRefusal(op)) return false;
		isTargetChanged.value = true;
		return true;
	};
	const refreshOp = useBackendOperation(api.aiRouting.embeddingCoverage.refresh, {
		label: label('refresh'),
	});
	const startReembedOp = useBackendOperation(api.aiRouting.embeddingReembed.startReembed, {
		label: label('startReembed'),
		type: 'action',
		onError: claimTargetChanged,
	});
	const resumeOp = useBackendOperation(api.aiRouting.embeddingReembedJobs.resumeReembed, {
		label: label('resume'),
	});
	const cancelOp = useBackendOperation(api.aiRouting.embeddingReembedJobs.cancelReembed, {
		label: label('cancel'),
	});
	const attestOp = useBackendOperation(api.aiRouting.embeddingAttestations.attest, {
		label: label('attest'),
	});
	const revokeOp = useBackendOperation(api.aiRouting.embeddingAttestations.revoke, {
		label: label('revoke'),
	});
	const startRebuildOp = useBackendOperation(api.aiRouting.embeddingRebuild.startRebuild, {
		label: label('startRebuild'),
		type: 'action',
	});
	const validateOp = useBackendOperation(api.aiRouting.embeddingRebuild.validateStaged, {
		label: label('validate'),
		type: 'action',
		onError: claimTargetChanged,
	});
	const activateOp = useBackendOperation(api.aiRouting.embeddingRebuild.activateStaged, {
		label: label('activate'),
		type: 'action',
		onError: (op) => {
			if (claimTargetChanged(op)) return true;
			const failed = failedValidationOf(op);
			if (failed) validation.value = failed;
			return failed !== null;
		},
	});
	const catchUpOp = useBackendOperation(api.aiRouting.embeddingRebuildState.catchUpRebuild, {
		label: label('catchUp'),
		onError: claimTargetChanged,
	});
	const cancelRebuildOp = useBackendOperation(api.aiRouting.embeddingRebuildState.cancelRebuild, {
		label: label('cancelRebuild'),
		onError: claimTargetChanged,
	});
	const rollbackOp = useBackendOperation(api.aiRouting.embeddingRebuildState.rollback, {
		label: label('rollback'),
		onError: claimTargetChanged,
	});

	const operations = [
		refreshOp,
		startReembedOp,
		resumeOp,
		cancelOp,
		attestOp,
		revokeOp,
		startRebuildOp,
		validateOp,
		activateOp,
		catchUpOp,
		cancelRebuildOp,
		rollbackOp,
	];
	const isBusy = computed(() => operations.some((op) => op.isLoading.value));

	/** The staged space's last validation; dropped when another space is staged. */
	const validation = ref<RebuildValidation | null>(null);
	watch(
		() => status.value?.staged?._id ?? null,
		(stagedId) => {
			if (validation.value && validation.value.spaceId !== stagedId) validation.value = null;
		}
	);

	/** Run an operation and toast its success line; resolves whether it landed. */
	async function done(start: () => Promise<{ ok: boolean }>, toastKey: string): Promise<boolean> {
		// Cleared before the call starts, so a refusal it reports stays shown.
		isTargetChanged.value = false;
		const { ok } = await start();
		if (ok) showToast(t(`${K}.toasts.${toastKey}`));
		return ok;
	}

	return {
		status,
		isLoading,
		error,
		refetch,
		isBusy,
		validation,
		isTargetChanged,
		refresh: () => done(() => refreshOp.run({}), 'refresh'),
		/**
		 * What the person confirmed: `spaceId`, the searchable space (absent while
		 * a switch is pending, none is); `targetKey`, the configured target
		 * (`status.configured.targetKey`), which names a switch's target too. The
		 * server refuses with `embedding_target_changed` when either moved.
		 */
		startReembed: (expected: { spaceId?: SpaceId; targetKey?: string } = {}) =>
			done(
				() =>
					startReembedOp.run({
						...(expected.spaceId ? { expectedSpaceId: expected.spaceId } : {}),
						...(expected.targetKey ? { expectedTargetKey: expected.targetKey } : {}),
					}),
				'startReembed'
			),
		resume: (job: EmbeddingJob) => done(() => resumeOp.run({ jobId: job._id }), 'resume'),
		cancel: (job: EmbeddingJob) => done(() => cancelOp.run({ jobId: job._id }), 'cancel'),
		attest: (args: AttestArgs) => done(() => attestOp.run(args), 'attest'),
		revoke: (attestationId: RevokeArgs['attestationId']) =>
			done(() => revokeOp.run({ attestationId }), 'revoke'),
		startRebuild: (target: RebuildTarget) => done(() => startRebuildOp.run(target), 'startRebuild'),
		async validate(expectedSpaceId: SpaceId): Promise<boolean> {
			isTargetChanged.value = false;
			const result = await validateOp.run({ expectedSpaceId });
			if (result.ok) validation.value = result.result;
			return result.ok;
		},
		async activate(expectedSpaceId: SpaceId): Promise<boolean> {
			isTargetChanged.value = false;
			const result = await activateOp.run({ expectedSpaceId });
			if (!result.ok) return false;
			validation.value = null;
			showToast(t(`${K}.toasts.activate`));
			return true;
		},
		/** Each names the staged space (or the rollback target) the admin confirmed. */
		catchUp: (expectedSpaceId: SpaceId) =>
			done(() => catchUpOp.run({ expectedSpaceId }), 'catchUp'),
		cancelRebuild: (expectedSpaceId: SpaceId) =>
			done(() => cancelRebuildOp.run({ expectedSpaceId }), 'cancelRebuild'),
		rollback: (expectedSpaceId: SpaceId) =>
			done(() => rollbackOp.run({ expectedSpaceId }), 'rollback'),
	};
}
