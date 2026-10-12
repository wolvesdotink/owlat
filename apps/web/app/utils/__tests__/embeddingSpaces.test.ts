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
	rowsOutOfSearch,
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
		expect(rowsOutOfSearch(status.coverage)).toBe(275);
		expect(unknownRows(status.coverage)).toBe(271);
		expect(rowsOutOfSearch(null)).toBe(0);
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
		expect(reembedBlocker(embeddingStatus())).toBe(`${K}.reembed.blocked.paidUnavailable`);
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
		const base = embeddingStatus({ active: null });
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
