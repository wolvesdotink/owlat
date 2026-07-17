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
