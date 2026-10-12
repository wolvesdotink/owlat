/**
 * The embedding section's reading of `aiRouting.embeddingSpaces.status` (U1,
 * D8, ADR-0073 §9), as pure functions: which space vector search uses, how
 * much of the corpus it reaches, the job in progress, what a re-embed would
 * cost, and the identity an attestation names. Message keys only; the
 * components translate.
 */
import type { FunctionReturnType } from 'convex/server';
import type { api } from '@owlat/api';
import type { ReembedJobStatus, ReembedPauseReason } from '@owlat/shared/aiRouting';
import { embeddingProviderMeta, type EmbeddingProviderKind } from '~/utils/aiProviders';

export type EmbeddingStatus = FunctionReturnType<typeof api.aiRouting.embeddingSpaces.status>;
export type EmbeddingJob = EmbeddingStatus['jobs'][number];
export type EmbeddingSpaceView = NonNullable<EmbeddingStatus['active']>;
type CoverageCounts = NonNullable<EmbeddingStatus['coverage']>['knowledgeEntries'];

const K = 'dashboard.admin.instance.aiProvider.embeddingSpace';

/**
 * Where vector search stands:
 *   - `none`: no embedder is configured;
 *   - `switching`: the configuration names a space whose first vector has not
 *     landed, so vector search has nothing to compare yet (D8);
 *   - `searchable`: the configured space is active.
 */
export type EmbeddingSearchState = 'none' | 'switching' | 'searchable';

export function embeddingSearchState(status: EmbeddingStatus): EmbeddingSearchState {
	if (!status.configured) return 'none';
	return status.configured.isActive ? 'searchable' : 'switching';
}

/** One table's counts, and what vector search reaches of them. */
export interface CoverageRow {
	table: 'knowledgeEntries' | 'semanticFiles';
	counts: CoverageCounts;
	/** Rows with any vector; `active` of these are found by vector search. */
	withVector: number;
}

export function coverageRows(coverage: EmbeddingStatus['coverage']): CoverageRow[] {
	if (!coverage) return [];
	return (['knowledgeEntries', 'semanticFiles'] as const).map((table) => {
		const counts = coverage[table];
		return { table, counts, withVector: counts.active + counts.unknown + counts.inactive };
	});
}

/**
 * The most rows a re-embed would embed: every row without a vector in the
 * active space, the ones with no vector at all included (a hosted edit can
 * leave a row with none). An upper bound: the job skips rows with too little
 * text, expired entries and files still being processed, which the coverage
 * count does not separate (see the notes: the exact candidate count is not
 * exposed).
 */
export function reembedCandidates(coverage: EmbeddingStatus['coverage']): number {
	return coverageRows(coverage).reduce(
		(sum, row) => sum + row.counts.unknown + row.counts.inactive + row.counts.unembedded,
		0
	);
}

/** Rows whose vector has no recorded space: what an attestation can establish. */
export function unknownRows(coverage: EmbeddingStatus['coverage']): number {
	return coverageRows(coverage).reduce((sum, row) => sum + row.counts.unknown, 0);
}

/** The running or paused job of a kind; at most one job is open at a time. */
export function openJob(
	jobs: readonly EmbeddingJob[],
	kind: EmbeddingJob['kind']
): EmbeddingJob | null {
	return jobs.find((job) => job.kind === kind && isOpen(job.status)) ?? null;
}

/** The most recent finished job of a kind, for its outcome line. */
export function lastFinishedJob(
	jobs: readonly EmbeddingJob[],
	kind: EmbeddingJob['kind']
): EmbeddingJob | null {
	const finished = jobs.filter((job) => job.kind === kind && !isOpen(job.status));
	return finished.reduce<EmbeddingJob | null>(
		(latest, job) => (latest && latest.startedAt >= job.startedAt ? latest : job),
		null
	);
}

const isOpen = (status: ReembedJobStatus) => status === 'running' || status === 'paused';

/** Whether any job is open: a second start would be refused. */
export function hasOpenJob(jobs: readonly EmbeddingJob[]): boolean {
	return jobs.some((job) => isOpen(job.status));
}

/** Every pause reason and status has a sentence; a new one fails to compile here. */
const PAUSE_REASON_KEYS: Record<ReembedPauseReason | 'other', string> = {
	budget: `${K}.job.paused.budget`,
	provider_unavailable: `${K}.job.paused.providerUnavailable`,
	space_changed: `${K}.job.paused.spaceChanged`,
	other: `${K}.job.paused.other`,
};
const STATUS_KEYS: Record<Exclude<ReembedJobStatus, 'paused'>, string> = {
	running: `${K}.job.status.running`,
	completed: `${K}.job.status.completed`,
	cancelled: `${K}.job.status.cancelled`,
	failed: `${K}.job.status.failed`,
};

/** The catalog key for a job's state line. */
export function jobStateKey(job: EmbeddingJob): string {
	if (job.status === 'paused') return PAUSE_REASON_KEYS[job.pausedReason ?? 'other'];
	return STATUS_KEYS[job.status];
}

// ── Payment ────────────────────────────────────────────────────────────────

/**
 * Whether a piece of embedding work costs money. Read from what the server
 * says (the configured target's endpoint locality, a job's `isPaid`), and
 * `paid` whenever it says nothing about the target in question: paid work is
 * confirmed first and waits for spend admission, so a wrong `paid` costs a
 * click, a wrong `free` costs money.
 */
export type EmbeddingPayment = 'free' | 'paid';

/** A re-embed into the configured space: the server's locality of its endpoint. */
export function reembedPayment(status: EmbeddingStatus): EmbeddingPayment {
	return status.configured?.isLocal === true ? 'free' : 'paid';
}

/** An existing job: the server derived `isPaid` from its target space. */
export function jobPayment(job: EmbeddingJob): EmbeddingPayment {
	return job.isPaid ? 'paid' : 'free';
}

/** The staged space: its rebuild job's `isPaid`; with no job to tell, paid. */
export function stagedPayment(status: EmbeddingStatus): EmbeddingPayment {
	return rebuildJob(status)?.isPaid === false ? 'free' : 'paid';
}

/**
 * A rebuild into `kind`: free only for the configured kind on a local
 * endpoint, whose locality the server reported. Another kind's endpoint is not
 * exposed, so it counts as paid.
 */
export function rebuildTargetPayment(
	status: EmbeddingStatus,
	kind: EmbeddingProviderKind
): EmbeddingPayment {
	const configured = status.configured;
	return configured?.isLocal === true && configured.provider === kind ? 'free' : 'paid';
}

/** Why paid work cannot start: no spend admission on the server (its own flag). */
export function paidBlocker(status: EmbeddingStatus, payment: EmbeddingPayment): string | null {
	return payment === 'paid' && !status.isPaidEmbeddingAvailable ? `${K}.paid.unavailable` : null;
}

/**
 * Why a re-embed cannot start now, as a message key, or null when it can. A
 * local embedder re-embeds for free on this server; a hosted one is paid work
 * and needs spend admission (D8), which the server's flag reports.
 */
export function reembedBlocker(status: EmbeddingStatus): string | null {
	if (!status.configured) return `${K}.reembed.blocked.noEmbedder`;
	if (hasOpenJob(status.jobs)) return `${K}.reembed.blocked.jobOpen`;
	return paidBlocker(status, reembedPayment(status));
}

/** Why a job cannot be resumed, or null. */
export function resumeBlocker(status: EmbeddingStatus, job: EmbeddingJob): string | null {
	return paidBlocker(status, jobPayment(job));
}

// ── Attestation ────────────────────────────────────────────────────────────

/**
 * Who the attestation form speaks for: the configured embedder, the only
 * space whose vectors an attestation can put back into vector search. When it
 * is already active it is named by id; otherwise by its identity, whose width
 * the admin states (prefilled with the model's known width).
 */
export type AttestationSubject =
	| { kind: 'space'; spaceId: EmbeddingSpaceView['_id']; dimensions: number }
	| {
			kind: 'identity';
			provider: EmbeddingProviderKind;
			endpoint: string;
			model: string;
			suggestedDimensions: number | null;
	  };

export function attestationSubject(status: EmbeddingStatus): AttestationSubject | null {
	const configured = status.configured;
	if (!configured) return null;
	if (configured.isActive && status.active) {
		return { kind: 'space', spaceId: status.active._id, dimensions: status.active.dimensions };
	}
	const meta = embeddingProviderMeta(configured.provider);
	return {
		kind: 'identity',
		provider: configured.provider,
		endpoint: configured.endpoint,
		model: configured.model,
		suggestedDimensions: meta && meta.defaultModel === configured.model ? meta.dimensions : null,
	};
}

/**
 * Whether the section shows the attestation at all: a hosted embedder (a
 * local one re-embeds for free, and its measured identity carries a digest an
 * attestation cannot state) with unknown vectors waiting.
 */
export function isAttestationOffered(status: EmbeddingStatus): boolean {
	return (
		status.configured !== null && !status.configured.isLocal && unknownRows(status.coverage) > 0
	);
}

/**
 * Why the server would refuse an attestation for the configured embedder, as
 * a message key, or null. The vectors from before provenance are all in the
 * primary column, so the attested space must hold that column: a configured
 * space that lives in the secondary one is refused, and so is any while
 * another known space holds the primary one. (The server knows the column's
 * owner exactly; the status exposes only the active, staged and rollback
 * spaces, so this can miss a refusal, never invent one. See the notes.)
 */
export function attestationBlocker(status: EmbeddingStatus): string | null {
	const subject = attestationSubject(status);
	if (!subject) return null;
	const subjectId = subject.kind === 'space' ? subject.spaceId : null;
	if (subject.kind === 'space' && status.active?.slot !== 'primary') {
		return `${K}.attest.blocked.secondaryColumn`;
	}
	const others = [status.active, status.staged, status.rollbackTo].filter(
		(known) => known !== null && known._id !== subjectId
	);
	if (others.some((known) => known?.slot === 'primary')) return `${K}.attest.blocked.columnTaken`;
	return null;
}

/** The end of the attested period: the chosen day's end, never later than now. */
export function cohortEnd(day: string, now: number): number | null {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
	if (!match) return null;
	const end = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + 1).getTime();
	return Math.min(end, now - 1000);
}

// ── Staged rebuild ─────────────────────────────────────────────────────────

/**
 * The embedders a staged rebuild may move to without a new key: another local
 * embedder, or another model of the stored hosted provider. Everything else
 * goes through the provider settings (the D8 switch path).
 */
export function rebuildKinds(status: EmbeddingStatus): EmbeddingProviderKind[] {
	const configured = status.configured;
	if (!configured) return [];
	return configured.isLocal ? ['local', 'openaiCompatible'] : [configured.provider];
}

/** The staged space's rebuild job, open or last finished. */
export function rebuildJob(status: EmbeddingStatus): EmbeddingJob | null {
	const staged = status.staged;
	if (!staged) return null;
	const own = status.jobs.filter(
		(job) => job.kind === 'rebuild' && job.targetSpaceId === staged._id
	);
	return own.find((job) => isOpen(job.status)) ?? own[0] ?? null;
}
