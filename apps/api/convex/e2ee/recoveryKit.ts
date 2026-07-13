/**
 * Recovery-kit assembly — the PURE core of the Sealed Mail key-recovery kit
 * (plan 2026-07-11, locked decision D7: RECOVERY KIT ONLY, no admin escrow).
 *
 * A recovery kit is the armored OpenPGP PRIVATE key for one address plus
 * plain-language instructions for keeping it safe and using it to restore access
 * to sealed mail. It is the ONLY sanctioned way a private key ever leaves the
 * vault in the clear, and it is handed ONLY to the address's own operator (admin,
 * behind `e2ee/lifecycleNode.ts:exportRecoveryKit`). There is deliberately no
 * server-side copy of the plaintext key and no escrow: if every recovery kit is
 * lost AND `INSTANCE_SECRET` is lost, sealed history cannot be recovered — the
 * whole point of end-to-end encryption.
 *
 * No Convex imports, no `openpgp`, no I/O — just text assembly — so the exact
 * wording is unit-testable (`__tests__/recoveryKit.test.ts`) and the security
 * copy can be asserted verbatim.
 */

/** The inputs a recovery kit is built from (all PUBLIC except the private key itself). */
export interface RecoveryKitInput {
	/** The email address the key belongs to (`localpart@domain`). */
	address: string;
	/** The uppercase-hex OpenPGP fingerprint of the key. */
	fingerprint: string;
	/** The ASCII-armored OpenPGP private key block for the address. */
	privateKeyArmored: string;
	/** When the kit was generated (ms since epoch). */
	generatedAt: number;
}

/** The assembled recovery kit: the private key, a filename, and human instructions. */
export interface RecoveryKit {
	address: string;
	fingerprint: string;
	/** Armored private key — the material to store somewhere safe and offline. */
	privateKeyArmored: string;
	/** Plain-language, no-jargon guidance shown alongside the download. */
	instructions: string;
	/** A safe, descriptive filename for the downloaded `.asc` file. */
	filename: string;
	generatedAt: number;
}

/**
 * Group an OpenPGP fingerprint into space-separated 4-char blocks for readable
 * display (e.g. `A1B2 C3D4 …`). Cosmetic only.
 */
export function groupFingerprint(fingerprint: string): string {
	return (
		fingerprint
			.replace(/\s+/g, '')
			.toUpperCase()
			.match(/.{1,4}/g)
			?.join(' ') ?? fingerprint
	);
}

/** A filesystem-safe recovery-kit filename derived from the address. */
export function recoveryKitFilename(address: string): string {
	const safe = address.toLowerCase().replace(/[^a-z0-9._@-]+/g, '_');
	return `owlat-recovery-kit-${safe}.asc`;
}

/**
 * The plain-language instructions that ship with a recovery kit. No crypto
 * jargon beyond naming the file; it explains what the key is FOR, what happens if
 * it is lost, and how to use it to restore — never lectures. Kept in one place so
 * the wording is asserted verbatim in tests (the honesty audit).
 */
export function buildRecoveryKitInstructions(input: {
	address: string;
	fingerprint: string;
}): string {
	return [
		`Recovery kit for ${input.address}`,
		`Key fingerprint: ${groupFingerprint(input.fingerprint)}`,
		'',
		'This file is the private key that unlocks sealed mail sent to this address.',
		'',
		'Keep it safe:',
		'- Store it somewhere private and offline, like a password manager or an',
		"  encrypted drive. Anyone who has this file can read this address's sealed",
		'  mail, so treat it like a spare house key.',
		'- Do not email it to yourself or leave it in shared storage.',
		'',
		'If you ever need it:',
		'- If this instance is rebuilt or restored from a backup and can no longer',
		'  open older sealed mail, import this file in Settings to restore access.',
		'',
		'What happens if it is lost:',
		'- There is no master copy anywhere. If every recovery kit is lost and the',
		'  instance secret is also lost, sealed mail already received can no longer',
		'  be opened. That is the trade-off that keeps this mail private.',
	].join('\n');
}

/** Assemble a full recovery kit from its inputs (private key + instructions + filename). */
export function buildRecoveryKit(input: RecoveryKitInput): RecoveryKit {
	return {
		address: input.address,
		fingerprint: input.fingerprint,
		privateKeyArmored: input.privateKeyArmored,
		instructions: buildRecoveryKitInstructions({
			address: input.address,
			fingerprint: input.fingerprint,
		}),
		filename: recoveryKitFilename(input.address),
		generatedAt: input.generatedAt,
	};
}
