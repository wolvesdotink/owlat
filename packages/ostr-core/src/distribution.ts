/**
 * Distribution wire formats shared by aggregators (producers) and consumers:
 * the DNS TXT tier answer, DNS query-name construction (including the
 * reversed DNSBL-style IP form), and the signed snapshot + diff feed
 * (TRUST_REGISTRY_PLAN §8).
 *
 * Like the attestation module, signatures here are ed25519 over the RFC 8785
 * canonical form of the document with `sig` absent, `ed25519:` + base64.
 */
import { isAttestationSignature } from './attestation/sign.js';
import { isIpv4, parseIpv6Groups } from './attestation/ipAddress.js';
import { canonicalBytes } from './jcs.js';
import { ed25519Sign, ed25519Verify } from './crypto.js';
import type { SignedTreeHead } from './merkle/sth.js';
import type { SubjectRef, Tier } from './types.js';

const TIERS: readonly Tier[] = ['unknown', 'establishing', 'trusted', 'warned', 'flagged'];

/** The parsed form of the single-TXT answer served at <name>.q.<zone>. */
export interface DnsTierAnswer {
	v: 1;
	tier: Tier;
	score: number;
	policy: string;
	/** RFC 3339 instant the aggregator computed the score at. */
	asof: string;
	/** Optional evidence-page URL. */
	ref?: string;
}

export function formatDnsTierAnswer(answer: DnsTierAnswer): string {
	const base = `v=1; tier=${answer.tier}; score=${answer.score}; policy=${answer.policy}; asof=${answer.asof}`;
	return answer.ref === undefined ? base : `${base}; ref=${answer.ref}`;
}

export function parseDnsTierAnswer(
	txt: string
): { ok: true; answer: DnsTierAnswer } | { ok: false; errors: string[] } {
	const errors: string[] = [];
	const fields = new Map<string, string>();
	for (const part of txt.split(';')) {
		const trimmed = part.trim();
		if (trimmed === '') continue;
		const eq = trimmed.indexOf('=');
		if (eq <= 0) {
			errors.push(`malformed field: ${trimmed}`);
			continue;
		}
		const key = trimmed.slice(0, eq).trim();
		if (fields.has(key)) errors.push(`duplicate field: ${key}`);
		fields.set(key, trimmed.slice(eq + 1).trim());
	}
	if (fields.get('v') !== '1') errors.push('unsupported or missing v');
	const tier = fields.get('tier') as Tier | undefined;
	if (tier === undefined || !TIERS.includes(tier)) errors.push('unknown tier');
	const scoreText = fields.get('score');
	const score = scoreText !== undefined && /^\d{1,3}$/.test(scoreText) ? Number(scoreText) : NaN;
	if (!Number.isInteger(score) || score < 0 || score > 100)
		errors.push('score not an integer in [0,100]');
	const policy = fields.get('policy');
	if (policy === undefined || policy === '') errors.push('missing policy');
	const asof = fields.get('asof');
	if (asof === undefined || asof === '') errors.push('missing asof');
	if (errors.length > 0) return { ok: false, errors };
	const answer: DnsTierAnswer = {
		v: 1,
		tier: tier as Tier,
		score,
		policy: policy as string,
		asof: asof as string,
	};
	const ref = fields.get('ref');
	if (ref !== undefined) answer.ref = ref;
	return { ok: true, answer };
}

/** Query name for a domain tier lookup: `<domain>.q.<zone>`. */
export function domainQueryName(domain: string, zone: string): string {
	return `${domain}.q.${zone}`;
}

/**
 * Query name for an IP tier lookup, DNSBL-style: IPv4 reversed by octet,
 * IPv6 reversed by nibble, under `ip.q.<zone>`.
 */
export function ipQueryName(ip: string, zone: string): string {
	if (isIpv4(ip)) {
		return `${ip.split('.').reverse().join('.')}.ip.q.${zone}`;
	}
	const groups = parseIpv6Groups(ip);
	if (groups === null) throw new Error(`not an IP address: ${ip}`);
	const nibbles: string[] = [];
	for (const group of groups) {
		for (const nibble of group.toString(16).padStart(4, '0')) nibbles.push(nibble);
	}
	return `${nibbles.reverse().join('.')}.ip.q.${zone}`;
}

// ---- Signed snapshots + diff feed (§8.3) --------------------------------

export interface SnapshotEntry {
	subject: SubjectRef;
	tier: Tier;
	score: number;
}

/** A full scored-set snapshot, signed by the aggregator that produced it. */
export interface SnapshotFile {
	v: 1;
	policy: string;
	asOf: string;
	/** The log heads (as-of set) the scores were computed against. */
	heads: SignedTreeHead[];
	entries: SnapshotEntry[];
	sig: string;
}

export type UnsignedSnapshotFile = Omit<SnapshotFile, 'sig'>;

/** One line of the append-only diff feed between snapshots. */
export interface DiffFeedEntry {
	seq: number;
	asOf: string;
	entry: SnapshotEntry;
}

const SIGNATURE_PREFIX = 'ed25519:';

function signingView(file: UnsignedSnapshotFile): Record<string, unknown> {
	const view: Record<string, unknown> = Object.create(null);
	view['v'] = file.v;
	view['policy'] = file.policy;
	view['asOf'] = file.asOf;
	view['heads'] = file.heads;
	view['entries'] = file.entries;
	return view;
}

export function signSnapshot(file: UnsignedSnapshotFile, privateKeyBase64: string): SnapshotFile {
	const sig = SIGNATURE_PREFIX + ed25519Sign(canonicalBytes(signingView(file)), privateKeyBase64);
	return { ...file, sig };
}

export function verifySnapshotSignature(file: SnapshotFile, publicKeyBase64: string): boolean {
	if (file.v !== 1 || !isAttestationSignature(file.sig)) return false;
	const signature = file.sig.slice(SIGNATURE_PREFIX.length);
	return ed25519Verify(canonicalBytes(signingView(file)), signature, publicKeyBase64);
}
