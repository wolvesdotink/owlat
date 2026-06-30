/**
 * Email-address parsing primitives shared across apps.
 *
 * Three apps previously had their own parser at increasing levels of
 * sophistication:
 * - `apps/mta/src/queue/groups.ts` — naive `lastIndexOf('@')`
 * - `apps/mta/src/intelligence/contentScreening.ts` — display-name unwrap
 * - `apps/imap/src/mime.ts` — RFC 5322 address-list parsing with comma
 *   handling inside angle brackets / quoted strings
 *
 * Consolidated here so MTA, IMAP, and the API agree on what a valid sender
 * is. RFC 5322 §3.4 isn't fully implemented (group syntax, domain literals,
 * comments) — but the subset email clients actually emit is covered.
 */

export interface ParsedAddress {
	/** Display name, when present. Stripped of surrounding quotes. */
	name?: string;
	/** Address part, lowercased. */
	address: string;
}

/**
 * Parse one address. Accepts `email@host`, `<email@host>`, or
 * `"Name" <email@host>` / `Name <email@host>`. Returns `null` if no
 * `local@domain` can be extracted.
 */
export function parseAddress(input: string): ParsedAddress | null {
	const trimmed = input.trim();
	if (!trimmed) return null;
	const angle = trimmed.match(/^(.*?)<\s*([^>]+?)\s*>\s*$/);
	if (angle && angle[1] !== undefined && angle[2] !== undefined) {
		const rawName = angle[1].trim().replace(/^"(.*)"$/, '$1');
		const address = angle[2].toLowerCase();
		if (!address.includes('@')) return null;
		return { name: rawName || undefined, address };
	}
	// Bare address path — try to find one `local@domain` token.
	const bareMatch = trimmed.match(/([^\s<>]+@[^\s<>]+)/);
	if (!bareMatch || bareMatch[1] === undefined) return null;
	return { address: bareMatch[1].toLowerCase() };
}

/**
 * Parse a comma-separated address list (`From:` / `To:` / `Cc:` header value
 * after MIME-encoded-word decoding). Commas inside angle brackets and quoted
 * strings don't split.
 */
export function parseAddressList(value: string): ParsedAddress[] {
	const out: ParsedAddress[] = [];
	let depth = 0;
	let inQuote = false;
	let buf = '';
	const flush = (): void => {
		const parsed = parseAddress(buf);
		if (parsed) out.push(parsed);
		buf = '';
	};
	for (let i = 0; i < value.length; i++) {
		const ch = value[i];
		if (ch === '"') inQuote = !inQuote;
		if (!inQuote && ch === '<') depth += 1;
		if (!inQuote && ch === '>') depth -= 1;
		if (ch === ',' && depth === 0 && !inQuote) {
			flush();
			continue;
		}
		buf += ch;
	}
	flush();
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
