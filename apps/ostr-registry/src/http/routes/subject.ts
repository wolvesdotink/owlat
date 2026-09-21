/**
 * `GET /v1/subject/:subject` and its evidence page (plan §8.2).
 *
 * The score answer is the same `ScoreResult` the DNS TXT view summarizes —
 * spec 08 §8.2 makes a discrepancy between the two views of one aggregator a
 * defect, and the only way to keep that promise is for both to read the same
 * materialized index rather than recompute independently here. It is served
 * verbatim, not wrapped in an envelope, for the same reason.
 *
 * `:subject` is a domain, an IPv4 literal, or a percent-encoded canonical IPv6
 * literal. A subject nobody has ever attested to is a 404 on both routes: the
 * registry has no opinion, which is a different statement from `unknown` tier
 * (a subject with evidence too thin to score), and different again from an
 * empty page of a subject that does have evidence.
 *
 * The evidence page carries an inclusion proof per attestation, which spec 08
 * §8.2 requires of it: "so a client can verify without trusting the
 * aggregator". The proofs are against the log's latest published head, served
 * alongside them — a client MUST verify that head's signature itself (and
 * SHOULD cross-check it against `/v1/log/sth` and its own gossip) before
 * trusting a path that came from the same response.
 */
import type { SequencedAttestation, SignedTreeHead, SubjectRef } from '@owlat/ostr-core';
import type { Hono } from 'hono';
import type { RegistryLog, ScoreIndex } from '../../contracts.js';
import { CACHE_ANSWER } from '../cache.js';
import { notFound } from '../errors.js';
import { pagination, parseSubject } from '../params.js';

export interface SubjectRouteDeps {
	scores: ScoreIndex;
	/** The log the evidence was sequenced in — the source of the proofs. */
	log: RegistryLog;
}

/** A served attestation plus its audit path against {@link EvidencePage.head}. */
export interface EvidenceEntry extends SequencedAttestation {
	/**
	 * Hex audit path per RFC 6962 §2.1. Absent when no published head covers
	 * the entry yet, or when it was sequenced in another log — a missing proof
	 * is a statement about coverage, not an error.
	 */
	proof?: string[];
}

export interface EvidencePage {
	subject: SubjectRef;
	/** The head every `proof` is against; null before the log's first head. */
	head: SignedTreeHead | null;
	entries: EvidenceEntry[];
}

async function withProof(
	log: RegistryLog,
	head: SignedTreeHead | null,
	entry: SequencedAttestation
): Promise<EvidenceEntry> {
	if (head === null || entry.logId !== head.logId || entry.index >= head.treeSize) return entry;
	return { ...entry, proof: await log.inclusionProof(entry.index, head.treeSize) };
}

export function registerSubjectRoutes(app: Hono, deps: SubjectRouteDeps): void {
	app.get('/v1/subject/:subject', async (c) => {
		const subject = parseSubject(c.req.param('subject'));
		const result = await deps.scores.score(subject);
		if (result === null) throw notFound('no score for that subject');
		c.header('cache-control', CACHE_ANSWER);
		return c.json(result);
	});

	app.get('/v1/subject/:subject/evidence', async (c) => {
		const subject = parseSubject(c.req.param('subject'));
		const { offset, limit } = pagination(c);
		if ((await deps.scores.score(subject)) === null) throw notFound('no score for that subject');
		const entries = await deps.scores.evidence(subject, offset, limit);
		const head = await deps.log.head();
		const page: EvidencePage = {
			subject,
			head,
			entries: await Promise.all(entries.map((entry) => withProof(deps.log, head, entry))),
		};
		c.header('cache-control', CACHE_ANSWER);
		return c.json(page);
	});
}
