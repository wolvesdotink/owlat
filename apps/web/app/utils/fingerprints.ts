/**
 * OpenPGP fingerprint formatting for the Sealed-Mail trust surfaces (E5). One
 * place owns the normalize → uppercase → group-by-4 shape so the contact-key
 * panel (full fingerprint) and the key-change banner (short tail) can never drift
 * into two subtly-different renderings of the same value.
 *
 * These are pure display helpers over PUBLIC fingerprints — no key material, no
 * I/O. Both return `null` for an absent value so callers can `v-if` on them.
 */

/** Strip whitespace and uppercase — the canonical hex form a fingerprint prints in. */
function normalizeFingerprint(fp: string): string {
	return fp.replace(/\s+/g, '').toUpperCase();
}

/** Group a hex string into space-separated blocks of 4. */
function groupByFour(hex: string): string {
	return hex.replace(/(.{4})/g, '$1 ').trim();
}

/**
 * Full fingerprint, spaced every 4 hex characters (e.g. `A1B2 C3D4 …`). Used
 * where the whole identity is shown — the per-contact key panel.
 */
export function formatFingerprint(fp: string | null | undefined): string | null {
	if (!fp) return null;
	return groupByFour(normalizeFingerprint(fp));
}

/**
 * Short fingerprint — the last 16 hex characters, spaced every 4 (e.g.
 * `1122 3344 5566 7788`). Used where space is tight and a recognizable tail is
 * enough — the key-change banner's previous/new key rows.
 */
export function shortFingerprint(fp: string | null | undefined): string | null {
	if (!fp) return null;
	return groupByFour(normalizeFingerprint(fp).slice(-16));
}
