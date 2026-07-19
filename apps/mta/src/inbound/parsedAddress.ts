/**
 * Small helpers for reading a `@owlat/mail-message` {@link AddressObject} field
 * off a {@link ParsedMessage}.
 *
 * `parseMessage` types every address field as `AddressObject | AddressObject[] |
 * undefined` (the `To:`/`Cc:`/`Bcc:` arms genuinely repeat), so the old
 * `mailparser`-era `parsed.from?.value?.[0]?.address` / `parsed.from?.text`
 * property chains no longer type-check against the union. These two helpers
 * normalize the union the way the inbound consumers need it, matching the
 * extraction the mail-sync ingest cutover already uses (`primaryAddress` /
 * `addrText` in `apps/mail-sync/src/ingest.ts`): a single-valued header
 * (`From:`/`Reply-To:`) is one object, and the array arm defensively reads the
 * LAST occurrence — consistent with `parseMessage` collapsing a repeated
 * single-valued header to its last instance (mailparser `singleKeys` parity).
 */

import type { AddressObject } from '@owlat/mail-message';

/** The single {@link AddressObject} for a field, or the LAST of a repeated one. */
function collapse(field: AddressObject | AddressObject[] | undefined): AddressObject | undefined {
	if (!field) return undefined;
	return Array.isArray(field) ? field[field.length - 1] : field;
}

/**
 * The first mailbox address of an address field, or `undefined` when the header
 * is absent / carries no address. Replaces `parsed.from?.value?.[0]?.address`.
 */
export function firstAddress(
	field: AddressObject | AddressObject[] | undefined
): string | undefined {
	return collapse(field)?.value[0]?.address;
}

/**
 * The reconstructed display text of an address field (what mailparser exposed as
 * `.text`), or `undefined` when the header is absent. Replaces `parsed.from?.text`.
 */
export function addressText(
	field: AddressObject | AddressObject[] | undefined
): string | undefined {
	return collapse(field)?.text;
}

export interface DmarcFromIdentity {
	/** The single validated RFC5322.From mailbox domain, normalized for DMARC. */
	readonly domain: string;
	/** True when no single syntactically valid mailbox identity can be established. */
	readonly invalid: boolean;
}

/**
 * Extract the trust-bearing RFC5322.From identity for DMARC independently of
 * the display-compatible parser's permissive recovery behavior. RFC 7489
 * requires exactly one From field containing exactly one mailbox: groups,
 * missing/unparseable values, repeated fields, and malformed angle content are
 * permanent evaluation errors rather than identities that may align.
 */
export function dmarcFromIdentity(
	field: AddressObject | AddressObject[] | undefined,
	rawValues: readonly string[]
): DmarcFromIdentity {
	if (rawValues.length !== 1 || !field) {
		return { domain: '', invalid: true };
	}
	if (Array.isArray(field) || field.value.length !== 1) {
		return { domain: '', invalid: true };
	}

	const mailbox = field.value[0]!;
	if (mailbox.group !== undefined) {
		return { domain: '', invalid: true };
	}
	const domain = validatedMailboxDomain(mailbox.address);
	if (domain === '' || rawMailboxAddress(rawValues[0] ?? '') !== mailbox.address) {
		return { domain: '', invalid: true };
	}
	return { domain, invalid: false };
}

const DOT_ATOM_LOCAL =
	/^[\p{L}\p{N}!#$%&'*+\-/=?^_`{|}~]+(?:\.[\p{L}\p{N}!#$%&'*+\-/=?^_`{|}~]+)*$/u;

/** Return the domain of one syntactically valid mailbox, or fail closed. */
function validatedMailboxDomain(address: string): string {
	const separator = unquotedAtSeparator(address);
	if (separator <= 0 || separator === address.length - 1) return '';

	const local = address.slice(0, separator);
	let domain = address.slice(separator + 1).toLowerCase();
	if (!validLocalPart(local)) return '';
	if (domain.endsWith('.')) domain = domain.slice(0, -1);
	if (domain === '' || domain.length > 253 || domain.startsWith('.')) return '';

	const labels = domain.split('.');
	if (
		labels.some(
			(label) =>
				label === '' ||
				label.length > 63 ||
				label.startsWith('-') ||
				label.endsWith('-') ||
				!/^[\p{L}\p{N}-]+$/u.test(label)
		)
	) {
		return '';
	}
	return domain;
}

/** Locate the mailbox's one unquoted `@`; reject controls/unbalanced quotes. */
function unquotedAtSeparator(address: string): number {
	let quoted = false;
	let escaped = false;
	let separator = -1;
	for (let i = 0; i < address.length; i++) {
		const ch = address[i]!;
		const code = ch.charCodeAt(0);
		if (code === 0x7f || code < 0x20) return -1;
		if (escaped) {
			escaped = false;
			continue;
		}
		if (quoted && ch === '\\') {
			escaped = true;
			continue;
		}
		if (ch === '"') {
			quoted = !quoted;
			continue;
		}
		if (!quoted && ch === '@') {
			if (separator !== -1) return -1;
			separator = i;
		}
	}
	return quoted || escaped ? -1 : separator;
}

/** Validate an RFC 5322 dot-atom or quoted-string local-part. */
function validLocalPart(local: string): boolean {
	if (local.startsWith('"') || local.endsWith('"')) {
		if (local.length < 2 || !local.startsWith('"') || !local.endsWith('"')) return false;
		let escaped = false;
		for (const ch of local.slice(1, -1)) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (ch === '\\') {
				escaped = true;
				continue;
			}
			if (ch === '"' || ch.charCodeAt(0) === 0x7f || ch.charCodeAt(0) < 0x20) return false;
		}
		return !escaped;
	}

	return DOT_ATOM_LOCAL.test(local);
}

/**
 * Parse one raw From value without recovery. This deliberately supports the
 * normal RFC forms (bare addr-spec or phrase + angle-addr, quoted strings, and
 * comments) but rejects groups, lists, trailing garbage, and extra addr-specs.
 */
function rawMailboxAddress(raw: string): string | null {
	const withoutComments = stripComments(raw);
	if (withoutComments === null) return null;
	const value = withoutComments.trim();
	if (value === '') return null;

	let quoted = false;
	let escaped = false;
	let open = -1;
	let close = -1;
	for (let i = 0; i < value.length; i++) {
		const ch = value[i]!;
		const code = ch.charCodeAt(0);
		if (code === 0x7f || (code < 0x20 && ch !== '\t')) return null;
		if (escaped) {
			escaped = false;
			continue;
		}
		if (quoted && ch === '\\') {
			escaped = true;
			continue;
		}
		if (ch === '"') {
			quoted = !quoted;
			continue;
		}
		if (quoted) continue;
		if (ch === ':' || ch === ';' || ch === ',') return null;
		if (ch === '<') {
			if (open !== -1 || close !== -1) return null;
			open = i;
		} else if (ch === '>') {
			if (open === -1 || close !== -1) return null;
			close = i;
		}
	}
	if (quoted || escaped) return null;

	let address: string;
	if (open === -1 && close === -1) {
		address = value;
	} else {
		if (open < 0 || close <= open || value.slice(close + 1).trim() !== '') return null;
		const display = value.slice(0, open).trim();
		if (containsUnquotedAt(display)) return null;
		address = value.slice(open + 1, close).trim();
	}
	return validatedMailboxDomain(address) === '' ? null : address.toLowerCase();
}

/** Remove balanced RFC comments while preserving quoted-string contents. */
function stripComments(raw: string): string | null {
	let output = '';
	let quoted = false;
	let escaped = false;
	let depth = 0;
	for (const ch of raw) {
		if (escaped) {
			if (depth === 0) output += ch;
			escaped = false;
			continue;
		}
		if (ch === '\\' && (quoted || depth > 0)) {
			if (depth === 0) output += ch;
			escaped = true;
			continue;
		}
		if (depth > 0) {
			if (ch === '(') depth += 1;
			else if (ch === ')') depth -= 1;
			continue;
		}
		if (ch === '"') {
			quoted = !quoted;
			output += ch;
		} else if (!quoted && ch === '(') {
			depth = 1;
			output += ' ';
		} else if (!quoted && ch === ')') {
			return null;
		} else {
			output += ch;
		}
	}
	return depth === 0 && !quoted && !escaped ? output : null;
}

/** Whether a display phrase contains an unquoted mailbox separator. */
function containsUnquotedAt(value: string): boolean {
	let quoted = false;
	let escaped = false;
	for (const ch of value) {
		if (escaped) {
			escaped = false;
			continue;
		}
		if (quoted && ch === '\\') {
			escaped = true;
			continue;
		}
		if (ch === '"') quoted = !quoted;
		else if (!quoted && ch === '@') return true;
	}
	return false;
}
