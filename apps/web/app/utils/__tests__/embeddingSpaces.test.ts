/**
 * The embedding section's reading of the status: search state, coverage,
 * jobs, the re-embed blockers (local free, hosted paid through admission),
 * the attestation subject and the staged rebuild's allowed moves.
 */
import { describe, expect, it } from 'vitest';
import {
	attestationSubject,
	cohortEnd,
	coverageRows,
	embeddingSearchState,
	hasOpenJob,
	isAttestationOffered,
	jobStateKey,
	lastFinishedJob,
	openJob,
	rebuildJob,
	rebuildKinds,
	reembedBlocker,
	reembedCandidates,
	reembedPayment,
	jobPayment,
	stagedPayment,
	rebuildTargetPayment,
	paidBlocker,
	resumeBlocker,
	attestationBlocker,
	attestationIdentity,
	stagedActionBlocker,
	endpointOrigin,
	stagedKey,
	rollbackKey,
	configuredKey,
	pausedJobKey,
	unknownRows,
} from '../embeddingSpaces';
import { embeddingStatus, job, space, T0 } from './embeddingStatusFixtures';

const K = 'dashboard.admin.instance.aiProvider.embeddingSpace';

describe('search state and coverage', () => {
	it('reads none, switching and searchable', () => {
		expect(embeddingSearchState(embeddingStatus({ configured: null }))).toBe('none');
		const base = embeddingStatus();
		expect(embeddingSearchState(base)).toBe('searchable');
		expect(
			embeddingSearchState(
				embeddingStatus({ configured: { ...base.configured!, isActive: false } })
			)
		).toBe('switching');
	});

	it('counts what is out of vector search and what an attestation could establish', () => {
		const status = embeddingStatus();
		expect(coverageRows(status.coverage).map((row) => [row.table, row.withVector])).toEqual([
			['knowledgeEntries', 246],
			['semanticFiles', 43],
		]);
		// An old snapshot without the exact counts: the upper bound, unembedded rows included.
		expect(reembedCandidates(status.coverage)).toEqual({
			count: 279,
			isExact: false,
			skipped: null,
		});
		expect(unknownRows(status.coverage)).toBe(271);
		expect(reembedCandidates(null)).toEqual({ count: 0, isExact: false, skipped: null });
		const onlyUnembedded = embeddingStatus();
		onlyUnembedded.coverage = {
			...onlyUnembedded.coverage!,
			knowledgeEntries: { active: 9, unknown: 0, inactive: 0, unembedded: 2 },
			semanticFiles: { active: 3, unknown: 0, inactive: 0, unembedded: 0 },
		};
		expect(reembedCandidates(onlyUnembedded.coverage)).toEqual({
			count: 2,
			isExact: false,
			skipped: null,
		});
	});

	it('uses the exact candidate count by the job rule when the snapshot has it', () => {
		const exact = embeddingStatus();
		exact.coverage = {
			...exact.coverage!,
			knowledgeEntries: {
				...exact.coverage!.knowledgeEntries,
				reembedCandidates: 200,
				reembedSkipped: 37,
			},
			semanticFiles: { ...exact.coverage!.semanticFiles, reembedCandidates: 40, reembedSkipped: 2 },
		};
		expect(reembedCandidates(exact.coverage)).toEqual({ count: 240, isExact: true, skipped: 39 });
		// One table without it (a partial old snapshot) falls back to the bound.
		exact.coverage.semanticFiles = {
			...exact.coverage.semanticFiles,
			reembedCandidates: undefined,
		};
		expect(reembedCandidates(exact.coverage).isExact).toBe(false);
	});
});

describe('jobs', () => {
	const jobs = [
		job({ _id: 'old' as never, status: 'completed', startedAt: T0 - 2, finishedAt: T0 - 1 }),
		job({ _id: 'new' as never, status: 'failed', startedAt: T0, lastError: 'boom' }),
		job({ _id: 'open' as never, kind: 'rebuild', status: 'paused', pausedReason: 'budget' }),
	];

	it('finds the open job of a kind and the latest finished one', () => {
		expect(openJob(jobs, 'reembed')).toBeNull();
		expect(openJob(jobs, 'rebuild')?._id).toBe('open');
		expect(lastFinishedJob(jobs, 'reembed')?._id).toBe('new');
		expect(hasOpenJob(jobs)).toBe(true);
	});

	it('names each state, and each pause reason', () => {
		expect(jobStateKey(job())).toBe(`${K}.job.status.running`);
		expect(jobStateKey(job({ status: 'paused', pausedReason: 'provider_unavailable' }))).toBe(
			`${K}.job.paused.providerUnavailable`
		);
		expect(jobStateKey(job({ status: 'paused' }))).toBe(`${K}.job.paused.other`);
	});
});

describe('reembedBlocker', () => {
	it('refuses paid work until spend admission exists, never local work', () => {
		expect(reembedBlocker(embeddingStatus())).toBe(`${K}.paid.unavailable`);
		expect(reembedBlocker(embeddingStatus({ isPaidEmbeddingAvailable: true }))).toBeNull();
		const local = embeddingStatus();
		local.configured = { ...local.configured!, provider: 'local', isLocal: true };
		expect(reembedBlocker(local)).toBeNull();
	});

	it('refuses a second job and an unconfigured embedder', () => {
		expect(reembedBlocker(embeddingStatus({ isPaidEmbeddingAvailable: true, jobs: [job()] }))).toBe(
			`${K}.reembed.blocked.jobOpen`
		);
		expect(reembedBlocker(embeddingStatus({ configured: null }))).toBe(
			`${K}.reembed.blocked.noEmbedder`
		);
	});
});

describe('attestation', () => {
	it('names the active configured space by id', () => {
		expect(attestationSubject(embeddingStatus())).toEqual({
			kind: 'space',
			spaceId: 'sp_active',
			dimensions: 1536,
		});
	});

	it('names an inactive configured embedder by identity, with the known width suggested', () => {
		const base = embeddingStatus({
			active: null,
			attestation: { canAttest: true, reason: null, spaceId: null },
		});
		const status = { ...base, configured: { ...base.configured!, isActive: false } };
		expect(attestationSubject(status)).toEqual({
			kind: 'identity',
			provider: 'openai',
			endpoint: 'native',
			model: 'text-embedding-3-small',
			suggestedDimensions: 1536,
		});
		const large = {
			...status,
			configured: { ...status.configured, model: 'text-embedding-3-large' },
		};
		expect(attestationSubject(large)).toMatchObject({ suggestedDimensions: null });
		expect(attestationSubject(embeddingStatus({ configured: null }))).toBeNull();
	});

	it('is offered for a hosted embedder with unknown vectors only', () => {
		expect(isAttestationOffered(embeddingStatus())).toBe(true);
		const local = embeddingStatus();
		local.configured = { ...local.configured!, isLocal: true };
		expect(isAttestationOffered(local)).toBe(false);
		const counted = embeddingStatus();
		counted.coverage = {
			...counted.coverage!,
			knowledgeEntries: { active: 5, unknown: 0, inactive: 0, unembedded: 0 },
			semanticFiles: { active: 1, unknown: 0, inactive: 0, unembedded: 0 },
		};
		expect(isAttestationOffered(counted)).toBe(false);
	});

	it('ends the cohort at the chosen day, never after now', () => {
		const now = new Date(2026, 9, 12, 15, 0).getTime();
		expect(cohortEnd('2026-10-01', now)).toBe(new Date(2026, 9, 2).getTime());
		expect(cohortEnd('2026-10-12', now)).toBe(now - 1000);
		expect(cohortEnd('', now)).toBeNull();
		expect(cohortEnd('12.10.2026', now)).toBeNull();
	});
});

describe('staged rebuild', () => {
	it('moves between local embedders, or within the stored hosted provider', () => {
		expect(rebuildKinds(embeddingStatus())).toEqual(['openai']);
		const local = embeddingStatus();
		local.configured = { ...local.configured!, provider: 'local', isLocal: true };
		expect(rebuildKinds(local)).toEqual(['local', 'openaiCompatible']);
		expect(rebuildKinds(embeddingStatus({ configured: null }))).toEqual([]);
	});

	it('finds the staged space own rebuild job', () => {
		const staged = space({ _id: 'sp_staged' as never, state: 'staged', slot: 'secondary' });
		const own = job({ kind: 'rebuild', targetSpaceId: 'sp_staged' as never, status: 'completed' });
		const status = embeddingStatus({
			staged,
			jobs: [job({ kind: 'rebuild', status: 'cancelled' }), own],
		});
		expect(rebuildJob(status)).toBe(own);
		expect(rebuildJob(embeddingStatus())).toBeNull();
	});
});

describe('payment, from what the server says', () => {
	it('reads the configured endpoint locality, not the catalog kind (Sol r5 F4)', () => {
		const publicCompatible = embeddingStatus();
		publicCompatible.configured = {
			...publicCompatible.configured!,
			provider: 'openaiCompatible',
			endpoint: 'https://embeddings.example.com',
			isLocal: false,
		};
		publicCompatible.rebuildTargets = [
			{ kind: 'local', isLocal: true },
			{ kind: 'openaiCompatible', isLocal: false },
		];
		expect(reembedPayment(publicCompatible)).toBe('paid');
		// The server's locality of each rebuild target, not the catalog kind.
		expect(rebuildTargetPayment(publicCompatible, 'openaiCompatible')).toBe('paid');
		expect(rebuildTargetPayment(publicCompatible, 'local')).toBe('free');
		// A kind the server does not list counts as paid.
		expect(rebuildTargetPayment(publicCompatible, 'google')).toBe('paid');
		const local = embeddingStatus();
		local.configured = { ...local.configured!, provider: 'local', isLocal: true };
		expect(reembedPayment(local)).toBe('free');
		expect(reembedPayment(embeddingStatus({ configured: null }))).toBe('paid');
	});

	it('takes a job from its isPaid and a staged space from its own locality', () => {
		expect(jobPayment(job({ isPaid: false }))).toBe('free');
		expect(jobPayment(job())).toBe('paid');
		const staged = space({ _id: 'sp_staged' as never, state: 'staged' });
		expect(stagedPayment(embeddingStatus({ staged }))).toBe('paid');
		expect(stagedPayment(embeddingStatus({ staged: { ...staged, isLocal: true } }))).toBe('free');
		expect(stagedPayment(embeddingStatus())).toBe('paid');
	});

	it('blocks paid work on the server admission flag, never free work', () => {
		expect(paidBlocker(embeddingStatus(), 'paid')).toBe(`${K}.paid.unavailable`);
		expect(paidBlocker(embeddingStatus({ isPaidEmbeddingAvailable: true }), 'paid')).toBeNull();
		expect(paidBlocker(embeddingStatus(), 'free')).toBeNull();
		const budget = job({ status: 'paused', pausedReason: 'budget' });
		expect(resumeBlocker(embeddingStatus(), budget)).toBe(`${K}.paid.unavailable`);
		expect(resumeBlocker(embeddingStatus(), { ...budget, isPaid: false })).toBeNull();
	});
});

describe('attestationBlocker, from the server rule', () => {
	it('allows what the server allows', () => {
		expect(attestationBlocker(embeddingStatus())).toBeNull();
	});

	it('names each refusal the server reports', () => {
		const secondary = embeddingStatus({
			attestation: { canAttest: false, reason: 'secondary_column', spaceId: 'sp_active' as never },
		});
		expect(attestationBlocker(secondary)).toBe(`${K}.attest.blocked.secondaryColumn`);
		const taken = embeddingStatus({
			attestation: { canAttest: false, reason: 'primary_owned_by_other_space', spaceId: null },
		});
		expect(attestationBlocker(taken)).toBe(`${K}.attest.blocked.columnTaken`);
		const none = embeddingStatus({
			attestation: { canAttest: false, reason: 'not_configured', spaceId: null },
		});
		expect(attestationBlocker(none)).toBeNull();
	});
});

describe('attestation identity (Sol r6 F2)', () => {
	it('shows an endpoint as its origin, never a path, query or credentials', () => {
		expect(endpointOrigin('native')).toBeNull();
		expect(endpointOrigin('https://user:pw@embed.example.com:8443/v1?key=x')).toBe(
			'https://embed.example.com:8443'
		);
		expect(endpointOrigin('embed.internal/v1')).toBe('embed.internal');
	});

	it('lists everything the attestation assigns', () => {
		expect(attestationIdentity(embeddingStatus(), null)).toEqual({
			provider: 'openai',
			endpointOrigin: null,
			model: 'text-embedding-3-small',
			dimensions: 1536,
			revision: null,
		});
		const base = embeddingStatus({
			active: null,
			attestation: { canAttest: true, reason: null, spaceId: null },
		});
		const status = { ...base, configured: { ...base.configured!, isActive: false } };
		expect(attestationIdentity(status, 3072)).toMatchObject({ dimensions: 3072, revision: null });
		// A registered space the status does not list (a retired primary owner): its width is on record.
		const retiredOwner = embeddingStatus({
			active: null,
			attestation: { canAttest: true, reason: null, spaceId: 'sp_retired' as never },
		});
		expect(attestationIdentity(retiredOwner, null)).toMatchObject({
			model: 'text-embedding-3-small',
			dimensions: null,
		});
		expect(attestationIdentity(embeddingStatus({ configured: null }), 1)).toBeNull();
	});
});

describe('confirmation target keys (Sol r6 F1)', () => {
	it('move when the target they name is replaced', () => {
		const a = embeddingStatus({ staged: space({ _id: 'sp_a' as never, state: 'staged' }) });
		const b = embeddingStatus({ staged: space({ _id: 'sp_b' as never, state: 'staged' }) });
		expect(stagedKey(a)).not.toBe(stagedKey(b));
		expect(stagedKey(embeddingStatus())).toBeNull();
		const withPrevious = embeddingStatus({ rollbackTo: space({ _id: 'sp_p' as never }) });
		expect(rollbackKey(withPrevious)).not.toBeNull();
		expect(rollbackKey(embeddingStatus())).toBeNull();
		const moved = embeddingStatus();
		moved.configured = { ...moved.configured!, model: 'other' };
		expect(configuredKey(moved)).not.toBe(configuredKey(embeddingStatus()));
		const paused = job({ status: 'paused' });
		expect(pausedJobKey(embeddingStatus({ jobs: [paused] }), paused._id)).not.toBeNull();
		expect(pausedJobKey(embeddingStatus({ jobs: [job()] }), paused._id)).toBeNull();
	});
});

describe('stagedActionBlocker (Sol r7 F2)', () => {
	const staged = space({ _id: 'sp_a' as never, state: 'staged', isLocal: true });
	const rebuild = (status: 'running' | 'completed' | 'cancelled') =>
		job({ kind: 'rebuild', targetSpaceId: 'sp_a' as never, status, isPaid: false });

	it('needs a filled rebuild and no running job for validate and activate', () => {
		const filled = embeddingStatus({ staged, jobs: [rebuild('completed')] });
		expect(stagedActionBlocker(filled, 'activate')).toBeNull();
		expect(stagedActionBlocker(filled, 'validate')).toBeNull();
		const running = embeddingStatus({ staged, jobs: [rebuild('running'), rebuild('completed')] });
		expect(stagedActionBlocker(running, 'activate')).toBe(`${K}.rebuild.blocked.jobOpen`);
		const cancelled = embeddingStatus({ staged, jobs: [rebuild('cancelled')] });
		expect(stagedActionBlocker(cancelled, 'activate')).toBe(`${K}.rebuild.blocked.notFilled`);
		expect(stagedActionBlocker(cancelled, 'catchUp')).toBeNull();
	});

	it('needs spend admission for paid staged work', () => {
		const paid = embeddingStatus({
			staged: { ...staged, isLocal: false },
			jobs: [job({ kind: 'rebuild', targetSpaceId: 'sp_a' as never, status: 'completed' })],
		});
		expect(stagedActionBlocker(paid, 'validate')).toBe(`${K}.paid.unavailable`);
		expect(stagedActionBlocker({ ...paid, isPaidEmbeddingAvailable: true }, 'validate')).toBeNull();
	});
});
