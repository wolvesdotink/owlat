/**
 * The reference aggregator (plan §4.1): tails the log, runs the open scoring
 * policy over it, and materializes the §8 distribution surfaces — the HTTPS
 * answers, the DNS zone, the signed snapshot and the diff feed.
 *
 * "Stateless with respect to truth": everything in the store is recomputable
 * from the log and the policy, so a second aggregator holding the same log
 * prefix and the same `asOf` must produce the same numbers, the same zone and —
 * ed25519 being deterministic over RFC 8785 canonical bytes — the same snapshot
 * bytes down to the signature. Nothing here reads a clock: `asOf` is an
 * argument, and the scheduler that calls {@link MaterializedScoreIndex.refresh}
 * lives in the composition root.
 *
 * COST — a refresh is O(subjects x entries), and both factors are attacker
 * driven: the log is content-neutral, so anyone can name a fresh subject and
 * add another full pass over the whole log. `scoreSubject` is the only entry
 * point `@owlat/ostr-core/scoring` exposes and it redoes its shared per-refresh
 * work (ordering, exclusions, vouch load, observer standing) on every call, so
 * this module cannot hoist it. Until core exports a batch entry point —
 * `createScoringContext(entries, asOf)` + `scoreWith(context, subject)`, or
 * `scoreSubjects(entries, subjects, asOf)` — the aggregator bounds itself
 * instead: {@link MaterializedScoreIndexOptions.refreshWorkBudget} is checked
 * before the scoring loop and a refresh over budget warns loudly, because a
 * refresh that stops completing within its cadence freezes the zone, the
 * snapshot and the diff feed at once.
 */

import { compareRfc3339, isRfc3339 } from '@owlat/ostr-core';
import { POLICY_VERSION, scoreSubject } from '@owlat/ostr-core/scoring';
import type {
	DiffFeedEntry,
	ExplanationGroup,
	ScoreResult,
	SequencedAttestation,
	SignedTreeHead,
	SnapshotFile,
	SubjectRef,
} from '@owlat/ostr-core';
import type { RegistryLog, ScoreIndex } from '../contracts.js';
import { buildSnapshot, changedEntries } from './snapshot.js';
import { ScoreStore, type EvidenceRef, type MaterializedRow } from './store.js';
import { discoverSubjects, subjectKey } from './subjects.js';
import { renderZone, validateZoneConfig, type ZoneConfig } from './zone.js';

/** The subset of a pino logger this module needs. */
export interface AggregatorLogger {
	warn(fields: Record<string, unknown>, message: string): void;
}

export interface MaterializedScoreIndexOptions {
	/** SQLite file for the materialized view. The aggregator owns it; the log has its own. */
	dbPath: string;
	log: RegistryLog;
	/** Raw base64 ed25519 key the snapshot is signed with. */
	aggregatorPrivateKeyBase64: string;
	zone: ZoneConfig;
	/** Where refresh warnings go. Defaults to `console.warn`; the composition root passes pino. */
	logger?: AggregatorLogger;
	/** Overrides {@link DEFAULT_REFRESH_WORK_BUDGET}. */
	refreshWorkBudget?: number;
}

/** Log entries are pulled in pages so a large log never lands in one array-copy. */
const ENTRY_PAGE = 512;

/** Zone serial fallback before the first refresh has declared an as-of instant. */
const EPOCH = '1970-01-01T00:00:00Z';

/**
 * Warning threshold on `subjects x entries`, the unit of work a refresh does.
 * Measured against this policy at ~7µs per unit, so the default is roughly 35
 * seconds of scoring — comfortably inside an hourly cadence, and far enough
 * below it that an operator hears about the growth long before a refresh
 * overruns the next one.
 */
export const DEFAULT_REFRESH_WORK_BUDGET = 5_000_000;

/**
 * Evidence rows one {@link MaterializedScoreIndex.evidence} call may return.
 * The HTTP layer clamps its own pages far lower, but the layer holding the
 * store must not depend on its caller for a bound.
 */
export const MAX_EVIDENCE_PAGE = 500;

const consoleLogger: AggregatorLogger = {
	warn: (fields, message) => {
		console.warn(message, fields);
	},
};

export class MaterializedScoreIndex implements ScoreIndex {
	readonly #log: RegistryLog;
	readonly #store: ScoreStore;
	readonly #signingKey: string;
	readonly #zone: ZoneConfig;
	readonly #logger: AggregatorLogger;
	readonly #workBudget: number;
	/** The rendered zone and the store revision it was rendered from. */
	#zoneCache: { revision: number; text: string } | null = null;

	constructor(options: MaterializedScoreIndexOptions) {
		// Zone configuration is checked at wiring time rather than at the first
		// query: an origin or a nameserver that cannot be rendered into a zone
		// is a deployment error, and it should not first surface as a malformed
		// zone file at 03:00.
		validateZoneConfig(options.zone);
		this.#log = options.log;
		this.#store = new ScoreStore(options.dbPath);
		this.#signingKey = options.aggregatorPrivateKeyBase64;
		this.#zone = options.zone;
		this.#logger = options.logger ?? consoleLogger;
		this.#workBudget = options.refreshWorkBudget ?? DEFAULT_REFRESH_WORK_BUDGET;
	}

	/** Release the store's file handles. Not part of {@link ScoreIndex}; the composition root calls it. */
	close(): void {
		this.#store.close();
	}

	async refresh(asOf: string): Promise<{ subjects: number; asOf: string }> {
		if (!isRfc3339(asOf)) {
			throw new Error(`refresh: asOf is not an RFC 3339 instant: ${asOf}`);
		}
		const head = await this.#log.head();
		// An `asOf` before the declared head's timestamp would hide entries the
		// snapshot claims coverage of: the head says "these leaves", the policy
		// says "not yet visible", and the published artifact would disagree with
		// itself. The other direction — an `asOf` after the head — is normal
		// (the scheduler runs on its own cadence), and the published `asof` is
		// the head's timestamp, not this one.
		if (head !== null && compareRfc3339(asOf, head.timestamp) < 0) {
			throw new Error(
				`refresh: asOf ${asOf} precedes the timestamp of the declared head (${head.timestamp})`
			);
		}
		const entries = await this.#loadEntries(head);
		const logIds = new Set(entries.map((entry) => entry.logId));
		const loggedAt = new Map(entries.map((entry) => [entry.index, entry.loggedAt]));

		const discovered = discoverSubjects(entries);
		this.#checkBudget(discovered.length, entries.length, asOf);

		const rows: MaterializedRow[] = [];
		const evidence = new Map<string, EvidenceRef[]>();
		for (const subject of discovered) {
			// The same entry set for every subject: the policy's own §6.2 merge
			// decides what is admissible, and cross-subject signals (vouch load,
			// observer standing) need the whole set to be computed at all.
			const result = scoreSubject({ entries, subject: subject.subject, asOf });
			const refs = evidenceFor(result.explanation, logIds, loggedAt);
			// Spec 08 §8.1 lets an aggregator answer either `tier=unknown` or
			// NXDOMAIN for a subject with no evidence; this one answers
			// NXDOMAIN, so such a subject is absent from every surface rather
			// than published with a number derived from nothing. Discovery
			// names subjects from raw entries, so this is also what keeps a
			// retracted, appealed-away or not-yet-visible entry from minting a
			// published identity.
			if (refs.length === 0) continue;
			rows.push({
				key: subject.key,
				subject: result.subject,
				tier: result.tier,
				score: result.score,
				policy: result.policy,
				explanation: result.explanation,
				asOf,
			});
			evidence.set(subject.key, refs);
		}

		const previous = this.#store.tierAndScoreByKey();
		// The as-of head set is this log's latest published head. A mirror
		// tailing several logs declares one head per log here.
		const heads: SignedTreeHead[] = head === null ? [] : [head];
		const snapshot = buildSnapshot({ policy: POLICY_VERSION, asOf, heads, rows }, this.#signingKey);
		this.#store.commitRefresh({
			asOf,
			headAsOf: oldestHeadTimestamp(heads),
			heads,
			rows,
			evidence,
			changed: changedEntries(previous, rows),
			snapshot,
		});
		return { subjects: rows.length, asOf };
	}

	async score(subject: SubjectRef): Promise<ScoreResult | null> {
		const row = this.#store.score(subjectKey(subject));
		if (row === null) return null;
		return {
			subject: row.subject,
			tier: row.tier,
			score: row.score,
			policy: row.policy,
			explanation: row.explanation,
		};
	}

	async evidence(
		subject: SubjectRef,
		offset: number,
		limit: number
	): Promise<SequencedAttestation[]> {
		const indexes = this.#store.evidence(
			subjectKey(subject),
			Math.max(0, Math.trunc(offset)),
			Math.min(MAX_EVIDENCE_PAGE, Math.max(0, Math.trunc(limit)))
		);
		const fetched = await Promise.all(indexes.map((index) => this.#log.entry(index)));
		// A null means the index moved out from under the materialized view
		// (a rebuilt log); the next refresh repairs the pointer.
		return fetched.filter((entry): entry is SequencedAttestation => entry !== null);
	}

	async snapshot(): Promise<SnapshotFile | null> {
		return this.#store.latestSnapshot();
	}

	async diffSince(seq: number): Promise<DiffFeedEntry[]> {
		return this.#store.diffSince(Math.max(0, Math.trunc(seq)));
	}

	/**
	 * A bounded page of the feed, oldest first — {@link ScoreIndex.diffSince}
	 * with the caller's own ceiling pushed into the query.
	 *
	 * Deliberately not on the frozen contract, which takes no limit. The HTTP
	 * layer serves at most a hundred rows and prefers this when an index offers
	 * it, so an anonymous `/v1/diff` does not read a page fifty times the size of
	 * the answer only to slice it away.
	 */
	async diffPage(seq: number, limit: number): Promise<DiffFeedEntry[]> {
		return this.#store.diffSince(Math.max(0, Math.trunc(seq)), limit);
	}

	/**
	 * The whole zone as one string, because {@link ScoreIndex.dnsZone} returns
	 * one. A large scored set is therefore materialized twice — rows, then text
	 * — and a streaming or chunked variant needs a change to that frozen
	 * signature before this layer can offer one.
	 *
	 * Rendered once per refresh and held: the zone is a pure function of the
	 * materialized set, so between two refreshes every caller must get the same
	 * bytes anyway, and reading every score back to rebuild them per request is
	 * the most expensive answer this node serves. One consequence is intended —
	 * a row omitted from the zone is warned about once per refresh, not once per
	 * request, so a malformed subject cannot turn an anonymous GET into a log
	 * amplifier.
	 */
	async dnsZone(): Promise<string> {
		const revision = this.#store.revision();
		const cached = this.#zoneCache;
		if (cached !== null && cached.revision === revision) return cached.text;
		const rows = this.#store.allScores();
		const text = renderZone(rows, this.#zone, this.#store.zoneAsOf() ?? EPOCH, (row, reason) => {
			this.#logger.warn({ subject: row.subject, reason }, 'aggregator: row omitted from the zone');
		});
		this.#zoneCache = { revision, text };
		return text;
	}

	/**
	 * Warn before doing work the cadence cannot absorb. It is a warning rather
	 * than a refusal on purpose: a stale zone is worse than a slow one, and the
	 * operator — not this module — decides whether to shard, to raise the
	 * budget, or to stop accepting new subjects.
	 */
	#checkBudget(subjects: number, entries: number, asOf: string): void {
		const work = subjects * entries;
		if (work <= this.#workBudget) return;
		this.#logger.warn(
			{ subjects, entries, work, budget: this.#workBudget, asOf },
			'aggregator: refresh exceeds its work budget; scoring is O(subjects x entries) until ' +
				'@owlat/ostr-core exposes a batch scoring entry point'
		);
	}

	/**
	 * Every entry the declared head covers.
	 *
	 * Cutting at `head.treeSize` is what makes the snapshot checkable: a
	 * consumer that fetches the log at the head named in `heads` sees exactly
	 * these leaves. Entries appended since are scored by the next refresh, under
	 * the next head. Before the first head there is nothing to declare, so the
	 * pre-publication tail is scored best-effort against an empty head set.
	 *
	 * A short read is fatal. Scoring a strict prefix of what the head covers and
	 * then signing a snapshot that names that head produces a validly signed
	 * artifact misrepresenting its own input — which a monitor recomputing this
	 * aggregator reads as aggregator misbehaviour rather than a broken log.
	 */
	async #loadEntries(head: SignedTreeHead | null): Promise<SequencedAttestation[]> {
		const covered = head === null ? await this.#log.size() : head.treeSize;
		const entries: SequencedAttestation[] = [];
		let start = 0;
		while (start < covered) {
			const page = await this.#log.entries(start, Math.min(ENTRY_PAGE, covered - start));
			if (page.length === 0) break;
			entries.push(...page);
			start += page.length;
		}
		if (entries.length !== covered) {
			throw new Error(
				`refresh: the log returned ${entries.length} entries, but the declared head covers ` +
					`${covered}; refusing to sign a snapshot over a partial log`
			);
		}
		return entries;
	}
}

/**
 * The instant a published answer advertises: the oldest timestamp in the
 * declared head set (spec 08 §8.1). Null for an empty set, where there is no
 * coverage to claim at all.
 */
function oldestHeadTimestamp(heads: readonly SignedTreeHead[]): string | null {
	let oldest: string | null = null;
	for (const head of heads) {
		if (oldest === null || compareRfc3339(head.timestamp, oldest) < 0) oldest = head.timestamp;
	}
	return oldest;
}

/**
 * A subject's evidence pointers: exactly the entries the policy cited in the
 * explanation, which is its own account of what fed the number.
 *
 * Deliberately not the entries that *named* the subject. An attestation that
 * was retracted, excluded by an appeal, not yet visible at `asOf`, or logged
 * after it fed nothing, and listing it as the answer's evidence (spec 08 §8.2)
 * would overstate what the score rests on. The citations also carry what naming
 * cannot: indirect evidence, such as bare-IP records rolled up into a domain
 * that declared the range (D2).
 *
 * Citations from a foreign log are dropped: this store's indexes address this
 * log, and following one into the wrong log would page in an unrelated entry.
 */
function evidenceFor(
	explanation: readonly ExplanationGroup[],
	logIds: ReadonlySet<string>,
	loggedAt: ReadonlyMap<number, string>
): EvidenceRef[] {
	const indexes = new Set<number>();
	for (const group of explanation) {
		for (const ref of group.evidence) {
			if (logIds.has(ref.logId)) indexes.add(ref.index);
		}
	}
	const refs: EvidenceRef[] = [];
	for (const index of indexes) {
		const at = loggedAt.get(index);
		if (at !== undefined) refs.push({ index, loggedAt: at });
	}
	return refs.sort((a, b) =>
		a.loggedAt === b.loggedAt ? b.index - a.index : a.loggedAt < b.loggedAt ? 1 : -1
	);
}
