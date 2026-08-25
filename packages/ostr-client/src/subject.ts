/**
 * Subject identity for the consumer library: one stable key per scored party,
 * so a cache, a snapshot index and a DNS query all agree on what "the same
 * subject" means (spec 08 §8.1, plan D2).
 *
 * Identity is normalized here and nowhere else in this package. Domains are
 * lowercased and stripped of trailing dots; IP literals are canonicalized by
 * reusing `ipQueryName` from `@owlat/ostr-core`, whose reversed-label form is
 * already a canonical rendering of an address — every spelling of one IPv6
 * address produces the same nibble sequence, which is exactly the property a
 * map key needs. No address parsing is reimplemented here.
 */

import { ipQueryName, type SubjectRef } from '@owlat/ostr-core';

/**
 * Zone label handed to `ipQueryName` when it is used purely as a
 * canonicalizer. `.invalid` is reserved by RFC 2606 and can never be queried,
 * so a key can never be mistaken for a name someone meant to resolve.
 */
const KEY_ZONE = 'invalid';

/** RFC 1035 §2.3.4: 255 bytes on the wire, 253 in presentation form. */
const MAX_NAME_LENGTH = 253;
const MAX_LABEL_LENGTH = 63;
/** LDH labels, plus `_` for the underscore-prefixed names OSTR itself uses. */
const NAME_PATTERN = /^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/;

/**
 * Lowercased, trailing-dot-stripped domain; `null` for blank input **and for
 * anything that is not a resolvable name**.
 *
 * The validation is not decoration. The output of this function becomes a DNS
 * query name in {@link tierQueryName} and {@link rblQueryName}, and its input
 * routinely comes from a mail header — so a name carrying whitespace, a control
 * character, or ten kilobytes of padding would otherwise be handed straight to
 * whichever resolver the caller injected. A name that cannot be queried is not
 * a subject, and this returns `null` for it exactly as it does for blank input.
 */
export function normalizeDomainName(domain: string | undefined): string | null {
	if (domain === undefined) return null;
	const trimmed = domain.trim().toLowerCase().replace(/\.+$/, '');
	if (trimmed.length === 0 || trimmed.length > MAX_NAME_LENGTH) return null;
	if (!NAME_PATTERN.test(trimmed)) return null;
	if (trimmed.split('.').some((label) => label.length > MAX_LABEL_LENGTH)) return null;
	return trimmed;
}

/** An address that parses, in both the forms this package needs. */
export interface CanonicalIp {
	/** The trimmed, lowercased literal, safe to hand to `ipQueryName`. */
	literal: string;
	/** Spelling-independent map key. */
	key: string;
}

/** Canonicalize an IP literal, or `null` when it is not an address. */
export function canonicalIp(ip: string | undefined): CanonicalIp | null {
	if (ip === undefined) return null;
	const literal = ip.trim().toLowerCase();
	if (literal.length === 0) return null;
	try {
		return { literal, key: ipQueryName(literal, KEY_ZONE) };
	} catch {
		return null;
	}
}

/**
 * Stable key for a subject, or `null` when the reference names neither a
 * domain nor an address.
 *
 * Three distinct forms, because they are three distinct subjects in the
 * scoring policy (plan D2): a domain, a bare IP, and the `(ip, domain)` pair.
 * A snapshot holding all three for one sender keeps three entries and this
 * function keeps them apart; {@link subjectLookupKeys} is what re-introduces
 * the fallback from the specific to the general.
 */
export function subjectKey(subject: SubjectRef): string | null {
	return subjectLookupKeys(subject)[0] ?? null;
}

/**
 * The keys to try for a lookup, most specific first. A query for the
 * `(ip, domain)` pair falls back to the domain and then to the bare IP, so a
 * consumer that knows both still gets an answer from a snapshot that scores
 * only the domain.
 */
export function subjectLookupKeys(subject: SubjectRef): string[] {
	const domain = normalizeDomainName(subject.domain);
	const ip = canonicalIp(subject.ip);
	const keys: string[] = [];
	if (domain !== null && ip !== null) keys.push(`p:${domain}|${ip.key}`);
	if (domain !== null) keys.push(`d:${domain}`);
	if (ip !== null) keys.push(`i:${ip.key}`);
	return keys;
}

/**
 * True when an observer name is covered by an exclusion entry: the same name,
 * or a subdomain of it.
 *
 * Suffix matching on a label boundary, deliberately, rather than the §6.3
 * registrable-domain grouping: excluding `mail.example.com` must not silently
 * exclude `mx.example.com`, while excluding `example.com` must cover the
 * observer's own sub-names, which is what an operator means by "ignore this
 * party".
 */
export function observerMatches(observer: string, exclusion: string): boolean {
	const name = normalizeDomainName(observer);
	const excluded = normalizeDomainName(exclusion);
	if (name === null || excluded === null) return false;
	return name === excluded || name.endsWith(`.${excluded}`);
}
