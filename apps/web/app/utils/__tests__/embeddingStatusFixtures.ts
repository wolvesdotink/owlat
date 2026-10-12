/**
 * `aiRouting.embeddingSpaces.status` answers for the embedding section's
 * tests: a hosted OpenAI deployment after its first upgrade (everything from
 * before provenance unknown), and the overrides each case needs.
 */
import type { EmbeddingJob, EmbeddingSpaceView, EmbeddingStatus } from '../embeddingSpaces';

export const T0 = Date.UTC(2026, 9, 12, 8, 0);

export function space(over: Partial<EmbeddingSpaceView> = {}): EmbeddingSpaceView {
	return {
		_id: 'sp_active' as EmbeddingSpaceView['_id'],
		_creationTime: T0,
		provider: 'openai',
		endpoint: 'native',
		model: 'text-embedding-3-small',
		dimensions: 1536,
		source: 'stored_config',
		state: 'active',
		slot: 'primary',
		isLocal: false,
		createdAt: T0,
		updatedAt: T0,
		...over,
	};
}

export function job(over: Partial<EmbeddingJob> = {}): EmbeddingJob {
	return {
		_id: 'job_1' as EmbeddingJob['_id'],
		_creationTime: T0,
		kind: 'reembed',
		targetSpaceId: 'sp_active' as EmbeddingJob['targetSpaceId'],
		status: 'running',
		isPaid: true,
		phase: 'knowledgeEntries',
		scannedCount: 64,
		embeddedCount: 40,
		skippedCount: 0,
		failedCount: 0,
		startedAt: T0,
		updatedAt: T0,
		...over,
	};
}

const counts = (active: number, unknown: number, inactive = 0, unembedded = 0) => ({
	active,
	unknown,
	inactive,
	unembedded,
});

export function embeddingStatus(over: Partial<EmbeddingStatus> = {}): EmbeddingStatus {
	return {
		active: space(),
		staged: null,
		rollbackTo: null,
		configured: {
			provider: 'openai',
			endpoint: 'native',
			model: 'text-embedding-3-small',
			source: 'stored_config',
			isLocal: false,
			isActive: true,
			targetKey: '["openai","native","text-embedding-3-small",null]',
		},
		coverage: {
			_id: 'cov_1' as NonNullable<EmbeddingStatus['coverage']>['_id'],
			_creationTime: T0,
			knowledgeEntries: counts(12, 230, 4, 3),
			semanticFiles: counts(2, 41, 0, 1),
			measuredAt: T0,
			isCurrent: true,
		},
		jobs: [],
		attestations: [],
		isPaidEmbeddingAvailable: false,
		canStageRebuild: true,
		rebuildTargets: [
			{ kind: 'local', isLocal: true },
			{ kind: 'openai', isLocal: false },
			{ kind: 'google', isLocal: false },
			{ kind: 'openaiCompatible', isLocal: true },
		],
		attestation: {
			canAttest: true,
			reason: null,
			spaceId: 'sp_active' as EmbeddingSpaceView['_id'],
		},
		...over,
	};
}
