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
 * The rows a re-embed would embed. The coverage walk counts them by the job's
 * own rule (`reembedCandidates`: rows outside the active space with an input
 * the job uses); `isExact` then. A count stored before that field existed has
 * only the coarse columns, so it falls back to the upper bound (every row
 * without a vector in the active space, the ones with none included) and the
 * copy says "up to".
 */
export function reembedCandidates(coverage: EmbeddingStatus['coverage']): {
	count: number;
	isExact: boolean;
} {
	const rows = coverageRows(coverage);
	const isExact =
		rows.length > 0 && rows.every((row) => row.counts.reembedCandidates !== undefined);
	const count = rows.reduce(
		(sum, row) =>
			sum +
			(isExact
				? (row.counts.reembedCandidates ?? 0)
				: row.counts.unknown + row.counts.inactive + row.counts.unembedded),
		0
	);
	return { count, isExact };
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

/** A space: the server's locality of its endpoint (the rule its jobs are paid by). */
export function spacePayment(space: { isLocal: boolean } | null | undefined): EmbeddingPayment {
	return space?.isLocal === true ? 'free' : 'paid';
}

/** The staged space, by its own locality; with no staged space, paid. */
export function stagedPayment(status: EmbeddingStatus): EmbeddingPayment {
	return spacePayment(status.staged);
}

/**
 * A rebuild into `kind`: the server's locality of the endpoint `startRebuild`
 * resolves for that kind (`rebuildTargets`); a kind it does not list is paid.
 */
export function rebuildTargetPayment(
	status: EmbeddingStatus,
	kind: EmbeddingProviderKind
): EmbeddingPayment {
	return status.rebuildTargets.find((target) => target.kind === kind)?.isLocal === true
		? 'free'
		: 'paid';
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
	| { kind: 'space'; spaceId: EmbeddingSpaceView['_id']; dimensions: number | null }
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
	// The server names the registered space the configured target already has
	// (the active space, or the primary column's owner); null: a new registration.
	const spaceId = status.attestation.spaceId;
	if (spaceId) {
		const known = [status.active, status.staged, status.rollbackTo].find(
			(space) => space?._id === spaceId
		);
		return { kind: 'space', spaceId, dimensions: known?.dimensions ?? null };
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

const ATTESTATION_REASON_KEYS: Record<
	NonNullable<EmbeddingStatus['attestation']['reason']>,
	string | null
> = {
	// No configured embedder: the section is not offered at all.
	not_configured: null,
	primary_owned_by_other_space: `${K}.attest.blocked.columnTaken`,
	secondary_column: `${K}.attest.blocked.secondaryColumn`,
};

/**
 * Why the server would refuse an attestation for the configured target, as a
 * message key, or null: the server's own rule (`status.attestation`), the one
 * `attest` enforces.
 */
export function attestationBlocker(status: EmbeddingStatus): string | null {
	const { canAttest, reason } = status.attestation;
	if (canAttest || !reason) return null;
	return ATTESTATION_REASON_KEYS[reason];
}

/**
 * Everything an attestation assigns, as the admin must see it before stating
 * it (D8): the provider, the endpoint, the model, the vector width and the
 * revision when one is known. The endpoint is shown as an origin only: the
 * server stores no more than that, and a path, query or credentials must
 * never be displayed even if one slipped through.
 */
export interface AttestationIdentity {
	provider: EmbeddingProviderKind;
	/** `null`: the provider's own API (`native`). */
	endpointOrigin: string | null;
	model: string;
	/** `null` until the admin states it (an identity with no known width). */
	dimensions: number | null;
	revision: string | null;
}

/** An endpoint as an origin (`https://host:port`), never a path or credentials. */
export function endpointOrigin(endpoint: string): string | null {
	if (endpoint === 'native') return null;
	try {
		return new URL(endpoint).origin;
	} catch {
		return endpoint.replace(/^([a-z][a-z0-9+.-]*:\/\/)?(?:[^@/]*@)?([^/?#]*).*$/i, '$1$2');
	}
}

export function attestationIdentity(
	status: EmbeddingStatus,
	statedWidth: number | null
): AttestationIdentity | null {
	const subject = attestationSubject(status);
	if (!subject) return null;
	if (subject.kind === 'space') {
		const known = [status.active, status.staged, status.rollbackTo].find(
			(space) => space?._id === subject.spaceId
		);
		if (known) {
			return {
				provider: known.provider,
				endpointOrigin: endpointOrigin(known.endpoint),
				model: known.model,
				dimensions: known.dimensions,
				revision: known.revision ?? null,
			};
		}
		// A registered space the status does not list (a retired primary owner):
		// it is the configured identity; its width and revision are on record.
		const configured = status.configured!;
		return {
			provider: configured.provider,
			endpointOrigin: endpointOrigin(configured.endpoint),
			model: configured.model,
			dimensions: null,
			revision: null,
		};
	}
	return {
		provider: subject.provider,
		endpointOrigin: endpointOrigin(subject.endpoint),
		model: subject.model,
		dimensions: statedWidth,
		revision: null,
	};
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

// ── Confirmation targets ───────────────────────────────────────────────────

/**
 * Stable keys for what a held confirmation acts on (`useEmbeddingConfirm`):
 * the endpoints act on whatever is configured, staged or active when they
 * run, so a dialog is valid only while its key still matches the status.
 */
export function configuredKey(status: EmbeddingStatus | null): string | null {
	const configured = status?.configured;
	if (!configured) return null;
	return JSON.stringify([
		configured.provider,
		configured.endpoint,
		configured.model,
		configured.isLocal,
		status.active?._id ?? null,
	]);
}

/** The staged space, by id and model. */
export function stagedKey(status: EmbeddingStatus | null): string | null {
	const staged = status?.staged;
	return staged ? JSON.stringify([staged._id, staged.model]) : null;
}

/** A rollback: the active space and the one it would restore. */
export function rollbackKey(status: EmbeddingStatus | null): string | null {
	if (!status?.active || !status.rollbackTo) return null;
	return JSON.stringify([status.active._id, status.rollbackTo._id]);
}

/** A paused job, while it is still paused. */
export function pausedJobKey(status: EmbeddingStatus | null, jobId: string): string | null {
	const job = status?.jobs.find((candidate) => candidate._id === jobId);
	return job?.status === 'paused' ? JSON.stringify([job._id, 'paused']) : null;
}

/** What a staged action needs before it may run. */
export type StagedAction = 'validate' | 'activate' | 'catchUp';

/**
 * Why a staged action may not run now, or null. Read against the LIVE status
 * both to enable the button and while its confirmation is open: validation
 * and activation need the rebuild filled and no job running (a catch-up
 * started meanwhile would make Confirm pay for a validation the activation
 * then refuses); a catch-up needs no job running; and paid work needs spend
 * admission.
 */
export function stagedActionBlocker(status: EmbeddingStatus, action: StagedAction): string | null {
	if (!status.staged) return null;
	if (hasOpenJob(status.jobs)) return `${K}.rebuild.blocked.jobOpen`;
	if (action !== 'catchUp' && rebuildJob(status)?.status !== 'completed') {
		return `${K}.rebuild.blocked.notFilled`;
	}
	return paidBlocker(status, stagedPayment(status));
}
