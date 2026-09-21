/**
 * Email-address parsing primitives shared across apps.
 *
 * This module is an ADAPTER, not a parser. The repo used to carry two live
 * RFC 5322 address parsers: a regex-and-depth-counter here, and the
 * comment-aware, group-aware, length-bounded one in `@owlat/mail-message`
 * that the in-house message parser is built on. The mail path ran on the weak
 * one — `apps/imap`'s APPEND header extractor, the MTA's `/send` and inbound
 * routing, and the Convex sender derivations all call in through here, every
 * one of them on headers an unauthenticated peer controls.
 *
 * The regex it used (`/^(.*?)<\s*([^>]+?)\s*>\s*$/`) backtracked
 * catastrophically on a `<`-run with no closing `>` — measured here at 6.6 ms
 * for 4 KB, 26 ms for 8 KB, 111 ms for 16 KB, i.e. clean O(n^2) with no input
 * cap at all — so one crafted `From:` could pin a core for minutes. It also
 * had no RFC 5322 comment handling (`(a@b.com) real@z.com` parsed as the
 * address `(a@b.com)`) and no group syntax (`Friends: a@x, b@y;` yielded a
 * trailing-semicolon address `b@y;`).
 *
 * Rather than fix the same bugs twice, these functions now delegate to
 * `@owlat/mail-message`'s parser and map its `EmailAddress` onto the
 * {@link ParsedAddress} shape every call site here already expects — the same
 * re-export-the-one-implementation shape `apps/mta/src/bounce/verp.ts` uses
 * over `./verp`, and the same edge `./mailMime` already takes to
 * `@owlat/mail-message/parse/headers`. The `/parse/address` subpath is
 * imported (not the package root) so the web bundle that reaches this module
 * through the shared barrel pulls in the address/header scanners and nothing
 * else; both are browser-safe (`TextDecoder` only, no `node:` builtin), which
 * is why this can stay in the barrel instead of moving to a subpath export.
 */

import {
	type EmailAddress,
	parseAddressList as parseMailboxList,
	parseMailboxAddress,
} from '@owlat/mail-message/parse/address';

export interface ParsedAddress {
	/** Display name, when present. Stripped of surrounding quotes. */
	name?: string;
	/** Address part, lowercased. */
	address: string;
}

/** Narrow one `EmailAddress` to the shared shape, dropping the `name: ''` sentinel. */
function toParsedAddress(addr: EmailAddress): ParsedAddress {
	return addr.name === '' ? { address: addr.address } : { name: addr.name, address: addr.address };
}

/**
 * Parse one address. Accepts `email@host`, `<email@host>`, or
 * `"Name" <email@host>` / `Name <email@host>`. Returns `null` if no
 * `local@domain` can be extracted.
 *
 * Deliberately the single-mailbox entry point rather than
 * `parseAddressList(input)[0]`: callers hand this a field that holds ONE
 * address (an API `from`, an inbound recipient), where an unquoted comma in
 * the display phrase (`Smith, John <j@x>`) is part of the name and must not
 * be read as a list separator.
 */
export function parseAddress(input: string): ParsedAddress | null {
	const parsed = parseMailboxAddress(input);
	return parsed === null ? null : toParsedAddress(parsed);
}

/**
 * Parse a comma-separated address list (`From:` / `To:` / `Cc:` header value).
 * Commas inside angle brackets, quoted strings and RFC 5322 comments don't
 * split, and `Group: a@x, b@y;` is flattened to its members — the group
 * container itself has no address of its own, so it is not a recipient.
 * Entries that hold no parseable `local@domain` (an empty
 * `Undisclosed recipients:;` group, a stray comma) are dropped, as before.
 *
 * Display names come back RFC 2047-decoded, so a `=?utf-8?B?…?=` phrase reads
 * as text rather than as the encoded word itself.
 */
export function parseAddressList(value: string): ParsedAddress[] {
	const out: ParsedAddress[] = [];
	const push = (addr: EmailAddress): void => {
		if (addr.address !== '') out.push(toParsedAddress(addr));
	};
	for (const entry of parseMailboxList(value)) {
		if (entry.group !== undefined) {
			for (const member of entry.group) push(member);
			continue;
		}
		push(entry);
	}
	return out;
}

/**
 * Fold an email address into its canonical lookup key: trimmed and
 * lowercased. Use this anywhere an email is used as a dedup / blocklist /
 * index key so every call site agrees on the same key.
 *
 * Note: `.trim().toLowerCase()` and `.toLowerCase().trim()` produce identical
 * output for emails (whitespace is unaffected by case folding and ASCII case
 * folding is unaffected by surrounding whitespace), so this consolidates both
 * orderings. It does NOT strip `+tag` suffixes or otherwise canonicalize the
 * local part — only case + surrounding whitespace.
 */
export function normalizeEmail(raw: string): string {
	return raw.trim().toLowerCase();
}

/**
 * Extract the domain part of an email-ish string. Strict: throws when no
 * address can be parsed. Use `extractDomainOrNull` to swallow failures.
 */
export function extractDomain(input: string): string {
	const parsed = parseAddress(input);
	if (!parsed) throw new Error(`Invalid email address: ${input}`);
	const atIndex = parsed.address.lastIndexOf('@');
	if (atIndex === -1) throw new Error(`Invalid email address: ${input}`);
	return parsed.address.substring(atIndex + 1);
}

/**
 * Extract the domain part of an email-ish string, or `null` when no address
 * can be parsed. Used by best-effort code paths (e.g. spam screening) that
 * don't want to throw on malformed input.
 */
export function extractDomainOrNull(input: string): string | null {
	const parsed = parseAddress(input);
	if (!parsed) return null;
	const atIndex = parsed.address.lastIndexOf('@');
	if (atIndex === -1) return null;
	return parsed.address.substring(atIndex + 1);
}
