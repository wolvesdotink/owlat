/**
 * DNS zone generation (plan §8.1, spec 08 §8.1).
 *
 * The whole zone is a pure function of the materialized scored set: the rich
 * TXT answers under `q.<origin>`, plus the two A-record compatibility views
 * that let an existing Postfix or Rspamd configuration consume OSTR with no
 * code changes. Nothing here is hand-edited or hand-editable — the views are
 * derived from the same rows as the TXT zone, at the same as-of head set,
 * which spec 08 makes a MUST.
 *
 * NO-EVIDENCE SUBJECTS ANSWER NXDOMAIN. Spec 08 §8.1 requires an aggregator to
 * pick one of `tier=unknown` and NXDOMAIN for a subject nothing admissible has
 * been said about, and to document which. This one publishes a name only for a
 * subject the policy admitted evidence for, so everything else — including a
 * subject named only by a retracted, appealed-away or not-yet-visible entry —
 * is simply absent from the zone and answers NXDOMAIN. It never publishes
 * `tier=unknown` as a stand-in for "nothing is known".
 *
 * Nothing interpolated into the text is trusted. Owner names come from stored
 * subjects and the apex from operator configuration, and a name carrying a
 * newline would be an arbitrary-record injection — an apex NS pointing wherever
 * the injector likes. The log's own validation is upstream, in another module,
 * on another path; this one re-checks every label it renders and refuses a
 * configuration it cannot render safely.
 *
 * DNSSEC is deliberately absent. The zone MUST be served signed, and for a
 * zone this size churning hourly that means online signing with NSEC3 or
 * compact denial of existence — but that is the DNS server's job. This module
 * emits the unsigned zone text and never an RRSIG, NSEC or DNSKEY record.
 */

import {
	domainQueryName,
	formatDnsTierAnswer,
	ipQueryName,
	isFqdn,
	isIpAddress,
	isRfc3339,
} from '@owlat/ostr-core';
import type { SubjectRef, Tier } from '@owlat/ostr-core';

/** SOA timers, in seconds. */
export interface SoaTimers {
	refresh: number;
	retry: number;
	expire: number;
	minimum: number;
}

/** Where the aggregator publishes: the zone apex, the nameservers, and the evidence-page base URL. */
export interface ZoneConfig {
	/** Zone apex, e.g. `ostr.example`. */
	origin: string;
	/** Base URL for per-subject evidence pages, e.g. `https://ostr.example/s`. */
	refBaseUrl: string;
	/**
	 * Apex NS records. Defaults to `ns1.<origin>` and `ns2.<origin>`, which is
	 * right only for an operator who happens to name them that way — a
	 * vendor-hosted or anycast delegation names its own, and an apex NS RRset
	 * contradicting the delegation makes the zone unloadable as published.
	 */
	nameservers?: readonly string[];
	/** SOA MNAME. Defaults to the first nameserver; set it for a hidden primary. */
	primaryNameserver?: string;
	/** SOA RNAME, as a DNS name. Defaults to `hostmaster.<origin>`. */
	hostmaster?: string;
	/** Record TTL. Defaults to {@link DEFAULT_TTL_SECONDS}. */
	ttlSeconds?: number;
	/** SOA timers. Defaults follow the TTL; see {@link DEFAULT_SOA}. */
	soa?: Partial<SoaTimers>;
}

/**
 * One scored subject as the zone sees it.
 *
 * Deliberately without an as-of instant: a zone is rendered at one declared
 * head set, and every answer in it advertises that one instant (spec 08 §8.1).
 * A per-row instant would let one zone publish several, which is exactly the
 * overstatement the head-derived `asof` exists to prevent.
 */
export interface ZoneRow {
	subject: SubjectRef;
	tier: Tier;
	score: number;
	policy: string;
}

/** Called with any row the renderer refuses to publish, so the omission is not silent. */
export type OnInvalidRow = (row: ZoneRow, reason: string) => void;

/** ~1h for hot entries (spec 08 §8.1); the SOA parameters follow it. */
export const DEFAULT_TTL_SECONDS = 3600;
export const DEFAULT_SOA: SoaTimers = Object.freeze({
	refresh: 3600,
	retry: 900,
	expire: 1_209_600,
	minimum: 3600,
});

/** DNSBL/DNSWL convention: a `127.0.0.x` A record. */
const LISTED_ADDRESS = '127.0.0.2';

/** A single TXT character-string carries at most 255 bytes — bytes, not characters. */
const MAX_CHARACTER_STRING = 255;

/** Largest value a 32-bit unsigned DNS TTL / SOA timer field can carry. */
const MAX_TTL = 2_147_483_647;

/**
 * Arbitrary but fixed placeholder used to borrow `ipQueryName`'s reversal
 * (octets for IPv4, nibbles for IPv6) for the `bl.`/`wl.` views, which put the
 * reversed address directly under the view rather than under `ip.q.`. Reusing
 * the core function is the point: one implementation of the reversal, so the
 * compat views can never disagree with the TXT zone about a name.
 */
const REVERSAL_PROBE = 'invalid';
const REVERSAL_SUFFIX = `.ip.q.${REVERSAL_PROBE}`;

/** The zone configuration with every default resolved and every name checked. */
export interface ResolvedZone {
	origin: string;
	refBaseUrl: string;
	nameservers: string[];
	primaryNameserver: string;
	hostmaster: string;
	ttl: number;
	soa: SoaTimers;
}

function stripTrailingDots(name: string): string {
	return name.replace(/\.+$/, '');
}

/** Presentation form of a configured DNS name: trimmed, lowercased, no trailing dot. */
function dnsName(what: string, value: string): string {
	const name = stripTrailingDots(value.trim().toLowerCase());
	if (!isFqdn(name)) throw new Error(`zone config: ${what} is not a domain name: ${value}`);
	return name;
}

function timer(what: string, value: number | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	if (!Number.isInteger(value) || value <= 0 || value > MAX_TTL) {
		throw new Error(`zone config: ${what} must be a positive 32-bit integer, got ${value}`);
	}
	return value;
}

/**
 * Resolve and check a zone configuration. Called at wiring time, so an origin
 * or a nameserver that cannot be rendered into a zone fails when the operator
 * starts the node rather than when a resolver asks.
 */
export function validateZoneConfig(zone: ZoneConfig): ResolvedZone {
	const origin = dnsName('origin', zone.origin);
	const configured = zone.nameservers ?? [`ns1.${origin}`, `ns2.${origin}`];
	if (configured.length === 0) throw new Error('zone config: at least one nameserver is required');
	const nameservers = configured.map((name, at) => dnsName(`nameservers[${at}]`, name));
	const primary =
		zone.primaryNameserver === undefined
			? (nameservers[0] as string)
			: dnsName('primaryNameserver', zone.primaryNameserver);
	const hostmaster =
		zone.hostmaster === undefined ? `hostmaster.${origin}` : dnsName('hostmaster', zone.hostmaster);
	const soa = zone.soa ?? {};
	return {
		origin,
		refBaseUrl: refBase(zone.refBaseUrl),
		nameservers,
		primaryNameserver: primary,
		hostmaster,
		ttl: timer('ttlSeconds', zone.ttlSeconds, DEFAULT_TTL_SECONDS),
		soa: {
			refresh: timer('soa.refresh', soa.refresh, DEFAULT_SOA.refresh),
			retry: timer('soa.retry', soa.retry, DEFAULT_SOA.retry),
			expire: timer('soa.expire', soa.expire, DEFAULT_SOA.expire),
			minimum: timer('soa.minimum', soa.minimum, DEFAULT_SOA.minimum),
		},
	};
}

/** The evidence-page base, checked: it is interpolated into every TXT answer. */
function refBase(value: string): string {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error(`zone config: refBaseUrl is not a URL: ${value}`);
	}
	if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
		throw new Error(`zone config: refBaseUrl must be http(s), got ${parsed.protocol}`);
	}
	return value.replace(/\/+$/, '');
}

/**
 * Reversed-label form of an IP, without any zone suffix.
 *
 * KNOWN DUPLICATE, kept deliberately identical to `reversedIpLabels()` in
 * `@owlat/ostr-client`'s `rbl.ts` — same probe, same guard, so a query the
 * client builds and a name this zone publishes cannot drift apart. The wave
 * report asks `@owlat/ostr-core` for a `reversedIpLabels(ip)` primitive that
 * deletes both copies; core is frozen this wave.
 */
function reversedIp(ip: string): string {
	const name = ipQueryName(ip, REVERSAL_PROBE);
	// The slice below is only sound while core builds the name this way. If it
	// ever gains a label or changes separator, truncating real address labels
	// would silently make the compat views disagree with the TXT zone about a
	// name — the exact disagreement reusing core's reversal exists to prevent.
	if (!name.endsWith(REVERSAL_SUFFIX)) {
		throw new Error(`zone: ipQueryName no longer ends in ${REVERSAL_SUFFIX}: ${name}`);
	}
	return name.slice(0, -REVERSAL_SUFFIX.length);
}

/**
 * SOA serial derived from the as-of instant: monotonic in `asOf` (which is
 * itself monotonic across refreshes) and a pure function of it, so two
 * aggregators publishing the same scored set publish the same serial.
 *
 * One-second granularity. Two head sets published inside one second would share
 * a serial and a secondary would not transfer the second zone; heads are hourly
 * (spec 08 §8.1), so that is a documented bound rather than a live hazard. An
 * unparseable instant is fatal: mapping it to 0 would publish a zone that looks
 * older than every version before it.
 */
function zoneSerial(asOf: string): number {
	if (!isRfc3339(asOf)) throw new Error(`zone: as-of instant is not RFC 3339: ${asOf}`);
	return Math.floor(Date.parse(asOf) / 1000);
}

/**
 * Split into TXT character-strings on UTF-8 byte length, at code-point
 * boundaries. A character-string is capped in bytes, and the base URL an
 * operator configures is interpolated raw, so counting UTF-16 code units would
 * emit chunks a zone loader rejects.
 */
function chunkUtf8(value: string, maxBytes: number): string[] {
	const encoder = new TextEncoder();
	const chunks: string[] = [];
	let current = '';
	let bytes = 0;
	for (const codePoint of value) {
		const size = encoder.encode(codePoint).length;
		if (bytes + size > maxBytes) {
			chunks.push(current);
			current = '';
			bytes = 0;
		}
		current += codePoint;
		bytes += size;
	}
	if (current !== '' || chunks.length === 0) chunks.push(current);
	return chunks;
}

/** Zone-file rdata for a TXT record: quoted, escaped, split at the 255-byte limit. */
function txtRdata(value: string): string {
	return chunkUtf8(value, MAX_CHARACTER_STRING)
		.map((chunk) => `"${chunk.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
		.join(' ');
}

function record(name: string, ttl: number, type: string, rdata: string): string {
	return `${name}.\t${ttl}\tIN\t${type}\t${rdata}`;
}

/** Evidence-page URL for a subject, under the configured base. */
function refUrl(base: string, label: string): string {
	return `${base}/${encodeURIComponent(label)}`;
}

/**
 * The label a subject is published under, or a reason it is not.
 *
 * `(ip, domain)` pairs are not scored identities (see `./subjects.js`), but a
 * row carrying both is refused rather than guessed at: the DNS interface
 * defines exactly two query-name forms — `<domain>.q.<origin>` and the reversed
 * `<ip>.ip.q.<origin>` — and inventing a third would be a private extension.
 *
 * Everything else is a defence-in-depth check on a value that reaches zone text
 * verbatim.
 */
function publishedLabel(
	subject: SubjectRef
): { ok: true; label: string; isIp: boolean } | { ok: false; reason: string } {
	if (subject.domain !== undefined && subject.ip !== undefined) {
		return { ok: false, reason: 'an (ip, domain) pair has no query name' };
	}
	if (subject.domain !== undefined) {
		return isFqdn(subject.domain)
			? { ok: true, label: subject.domain, isIp: false }
			: { ok: false, reason: 'domain is not a renderable FQDN' };
	}
	if (subject.ip !== undefined) {
		return isIpAddress(subject.ip)
			? { ok: true, label: subject.ip, isIp: true }
			: { ok: false, reason: 'ip is not a renderable address literal' };
	}
	return { ok: false, reason: 'subject names nothing' };
}

function tierRecord(
	row: ZoneRow,
	zone: ResolvedZone,
	asOf: string,
	label: string,
	isIp: boolean
): string {
	const name = isIp ? ipQueryName(label, zone.origin) : domainQueryName(label, zone.origin);
	const answer = formatDnsTierAnswer({
		v: 1,
		tier: row.tier,
		score: row.score,
		policy: row.policy,
		asof: asOf,
		ref: refUrl(zone.refBaseUrl, label),
	});
	return record(name, zone.ttl, 'TXT', txtRdata(answer));
}

function viewRecord(zone: ResolvedZone, view: string, label: string, isIp: boolean): string {
	const name = isIp ? reversedIp(label) : label;
	return record(`${name}.${view}.${zone.origin}`, zone.ttl, 'A', LISTED_ADDRESS);
}

function header(zone: ResolvedZone, serial: number): string[] {
	const { origin, ttl, soa } = zone;
	return [
		`; OSTR query zone for ${origin}, generated by the reference aggregator.`,
		'; Derived from the transparency log; never hand-edited (spec 08 §8.1).',
		';',
		'; A subject the policy admitted no evidence for has no name here and',
		'; answers NXDOMAIN — never tier=unknown (spec 08 §8.1 requires one of',
		'; the two, documented; this is the one).',
		';',
		'; DNSSEC: this is the unsigned zone. It MUST be served signed — online',
		'; signing with NSEC3 or compact denial of existence, since it churns',
		"; hourly — but that is the DNS server's job, not the aggregator's.",
		`$ORIGIN ${origin}.`,
		`$TTL ${ttl}`,
		`@\t${ttl}\tIN\tSOA\t${zone.primaryNameserver}. ${zone.hostmaster}. ${serial} ${soa.refresh} ${soa.retry} ${soa.expire} ${soa.minimum}`,
		...zone.nameservers.map((name) => `@\t${ttl}\tIN\tNS\t${name}.`),
	];
}

function section(title: string, records: readonly string[]): string[] {
	return ['', `; ${title}`, ...[...records].sort()];
}

/**
 * Render the full zone text for `rows` as of `asOf`.
 *
 * `asOf` is the as-of head set's instant, not the moment the policy ran: spec
 * 08 §8.1 defines a published answer's `asof` as the timestamp of the declared
 * head it was scored against, so an aggregator whose log last published a head
 * an hour ago advertises that hour-old instant rather than overstating its
 * coverage.
 *
 * Rows may arrive in any order; every section is sorted by owner name, so the
 * text is a deterministic function of the scored set. A row that cannot be
 * rendered safely is skipped and reported through `onInvalidRow`.
 */
export function renderZone(
	rows: readonly ZoneRow[],
	config: ZoneConfig,
	asOf: string,
	onInvalidRow?: OnInvalidRow
): string {
	const zone = validateZoneConfig(config);
	// Fails before a single record is rendered if the instant is unusable.
	const serial = zoneSerial(asOf);
	const tier: string[] = [];
	const blocked: string[] = [];
	const allowed: string[] = [];
	for (const row of rows) {
		const published = publishedLabel(row.subject);
		if (!published.ok) {
			onInvalidRow?.(row, published.reason);
			continue;
		}
		const { label, isIp } = published;
		tier.push(tierRecord(row, zone, asOf, label, isIp));
		const view = row.tier === 'flagged' ? 'bl' : row.tier === 'trusted' ? 'wl' : null;
		if (view === null) continue;
		(view === 'bl' ? blocked : allowed).push(viewRecord(zone, view, label, isIp));
	}
	const lines = [
		...header(zone, serial),
		...section(`tier answers under q.${zone.origin}`, tier),
		...section(`bl.${zone.origin} compatibility view: flagged subjects only`, blocked),
		...section(`wl.${zone.origin} compatibility view: trusted subjects only`, allowed),
	];
	return `${lines.join('\n')}\n`;
}
