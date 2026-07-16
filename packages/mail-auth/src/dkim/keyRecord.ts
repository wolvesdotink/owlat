/**
 * RFC 6376 §3.6.1 DKIM public-key (`_domainkey` TXT) record parsing.
 *
 * The input is untrusted DNS data, so this parser is HOSTILE-INPUT SAFE: it
 * never throws. Every malformed record — an empty / revoked `p=`, a
 * `v=` mismatch, an unknown key type, joined TXT strings, or outright garbage —
 * resolves to a structured outcome the verifier can act on, never an
 * exception. (Locked decision D7: the verifier as a whole never throws.)
 */

/** A successfully-parsed DKIM key record. */
export interface DkimKeyRecord {
	/** `v=` — version. Absent is tolerated; when present it must be `DKIM1`. */
	readonly version?: string;
	/** `k=` — key type. Defaults to `rsa` per §3.6.1. */
	readonly keyType: 'rsa' | 'ed25519';
	/** `h=` — acceptable hash algorithms, if the record restricts them. */
	readonly hashAlgorithms?: readonly string[];
	/** `p=` — base64 public key material (empty string means revoked). */
	readonly publicKey: string;
	/** `t=` — flags (`y` testing, `s` no-subdomain, …). */
	readonly flags: readonly string[];
	/** `s=` — service types (`*` or `email`). */
	readonly serviceTypes: readonly string[];
	/** Convenience: `t=y` is set. */
	readonly testing: boolean;
	/** Convenience: `p=` is present but empty — the key has been revoked. */
	readonly revoked: boolean;
}

/** A record we could not use. `reason` distinguishes the failure classes. */
export interface DkimKeyRecordError {
	readonly error: true;
	/**
	 * `syntax`   — the record is not a parseable tag list / wrong version.
	 * `unsupported` — a syntactically-valid record with a key type we can't verify.
	 */
	readonly reason: 'syntax' | 'unsupported';
	readonly message: string;
}

export type ParsedKeyRecord = DkimKeyRecord | DkimKeyRecordError;

/** Type guard: did `parseDkimKeyRecord` fail? */
export function isKeyRecordError(record: ParsedKeyRecord): record is DkimKeyRecordError {
	return 'error' in record;
}

/**
 * Split a TXT record body into its `tag=value` pairs. Tag names are
 * case-sensitive per §3.2 except we lowercase them for lookup; values keep
 * their case. Whitespace (including folded FWS) around tags and values is
 * stripped. Duplicate tags: the FIRST occurrence wins (later ones ignored),
 * matching how a conservative verifier reads a hostile record.
 */
function parseTagList(txt: string): Map<string, string> {
	const tags = new Map<string, string>();
	for (const segment of txt.split(';')) {
		const eq = segment.indexOf('=');
		if (eq === -1) {
			continue;
		}
		const name = segment.slice(0, eq).trim().toLowerCase();
		if (name === '') {
			continue;
		}
		// Strip all internal whitespace from the value: base64 (`p=`, folded
		// across TXT chunks) and colon-lists (`h=`, `t=`) never contain WSP.
		const value = segment.slice(eq + 1).replace(/[ \t\r\n]+/g, '');
		if (!tags.has(name)) {
			tags.set(name, value);
		}
	}
	return tags;
}

/**
 * Parse one joined DKIM key TXT record. `txt` is the concatenation of the
 * record's character-strings (RFC 1035 §3.3.14) — the caller joins multi-chunk
 * TXT records before calling.
 */
export function parseDkimKeyRecord(txt: string): ParsedKeyRecord {
	const tags = parseTagList(txt);

	// v= is optional, but if present it MUST be DKIM1 (§3.6.1).
	const version = tags.get('v');
	if (version !== undefined && version !== '' && version !== 'DKIM1') {
		return { error: true, reason: 'syntax', message: `unsupported key version: ${version}` };
	}

	const keyTypeRaw = tags.get('k') ?? 'rsa';
	if (keyTypeRaw !== 'rsa' && keyTypeRaw !== 'ed25519') {
		return { error: true, reason: 'unsupported', message: `unsupported key type: ${keyTypeRaw}` };
	}

	// p= MUST be present. Absent tag => malformed; present-but-empty => revoked.
	const publicKey = tags.get('p');
	if (publicKey === undefined) {
		return { error: true, reason: 'syntax', message: 'missing p= tag' };
	}

	const flags = splitList(tags.get('t'));
	const serviceTypes = splitList(tags.get('s'));
	const hashTag = tags.get('h');
	const hashAlgorithms = hashTag !== undefined && hashTag !== '' ? splitList(hashTag) : undefined;

	return {
		version,
		keyType: keyTypeRaw,
		hashAlgorithms,
		publicKey,
		flags,
		serviceTypes,
		testing: flags.includes('y'),
		revoked: publicKey === '',
	};
}

/** Split a colon-separated tag list (`h=`, `t=`, `s=`) into lowercase items. */
function splitList(value: string | undefined): string[] {
	if (value === undefined || value === '') {
		return [];
	}
	return value
		.split(':')
		.map((item) => item.trim().toLowerCase())
		.filter((item) => item !== '');
}
