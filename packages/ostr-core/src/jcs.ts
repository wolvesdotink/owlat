/**
 * RFC 8785 (JSON Canonicalization Scheme) serializer.
 *
 * Signatures and byte-identical scoring explanations are computed over this
 * form. Number formatting follows ECMAScript `JSON.stringify` exactly as the
 * RFC requires; object members are sorted by UTF-16 code units. `toJSON`
 * methods are deliberately not honored — attestations are plain data.
 */

function canonicalizeValue(value: unknown, out: string[]): void {
	if (value === null) {
		out.push('null');
		return;
	}
	switch (typeof value) {
		case 'boolean':
		case 'string':
			out.push(JSON.stringify(value));
			return;
		case 'number':
			if (!Number.isFinite(value)) {
				throw new Error('JCS cannot serialize non-finite numbers');
			}
			out.push(JSON.stringify(value));
			return;
		case 'object':
			break;
		default:
			throw new Error(`JCS cannot serialize a ${typeof value}`);
	}
	if (Array.isArray(value)) {
		out.push('[');
		for (let i = 0; i < value.length; i++) {
			if (i > 0) out.push(',');
			// JSON.stringify semantics: undefined array elements become null.
			canonicalizeValue(value[i] === undefined ? null : value[i], out);
		}
		out.push(']');
		return;
	}
	const record = value as Record<string, unknown>;
	// Default Array.prototype.sort() compares UTF-16 code units — exactly the
	// member ordering RFC 8785 §3.2.3 specifies.
	const keys = Object.keys(record).sort();
	out.push('{');
	let first = true;
	for (const key of keys) {
		const member = record[key];
		// JSON.stringify semantics: undefined members are omitted.
		if (member === undefined) continue;
		if (!first) out.push(',');
		first = false;
		out.push(JSON.stringify(key), ':');
		canonicalizeValue(member, out);
	}
	out.push('}');
}

/** Serialize `value` to its RFC 8785 canonical JSON text. */
export function canonicalize(value: unknown): string {
	const out: string[] = [];
	canonicalizeValue(value, out);
	return out.join('');
}

/** Canonical JSON text as UTF-8 bytes — the exact input signatures are computed over. */
export function canonicalBytes(value: unknown): Buffer {
	return Buffer.from(canonicalize(value), 'utf8');
}
