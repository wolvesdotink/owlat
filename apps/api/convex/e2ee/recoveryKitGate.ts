/**
 * The gate in front of a MEMBER's own recovery kit (plan idea 55).
 *
 * A recovery kit is the one sanctioned egress of a private key from the vault
 * (locked decision D7). Until now only an admin could ask for one, for any
 * address. Idea 55 puts the same download on the member's own preferences page,
 * which means the gate — not the crypto — is the security-sensitive part: a live
 * session on an unlocked laptop must not be enough to walk away with the key
 * that opens someone's sealed mail.
 *
 * So the export is guarded by four checks in a FIXED order, and that order is
 * the whole point of this module being separate, pure and injectable:
 *
 *   1. FEATURE — with `sealedMail` off there is no sealed mail to recover, and
 *      the private-key egress stays shut. Nothing else runs, nothing is logged.
 *   2. OWNERSHIP — the address must be one this caller actually sends as. This
 *      runs BEFORE the password so a request that can never succeed never costs
 *      a password hash, and so a stolen session cannot fish for other people's
 *      keys by spending guesses.
 *   3. THROTTLE — recent failed re-authentications block the attempt before any
 *      verification work happens. A password prompt with no rate limit in front
 *      of it is a password prompt an attacker can simply out-wait.
 *   4. PASSWORD — the re-prompt itself. A failure is RECORDED (feeding step 3)
 *      and the export is never reached.
 *
 * Only after all four does the kit get assembled. The ordering is asserted in
 * `__tests__/recoveryKitGate.test.ts` against recording spies, so a later
 * refactor that quietly hashes before the throttle, or assembles the kit before
 * the password, fails the build rather than shipping.
 *
 * Pure: no Convex imports, no `openpgp`, no I/O — every effect arrives as an
 * injected dependency.
 */

/** Why an export was refused. Deliberately coarse — see {@link guardRecoveryKitExport}. */
export type RecoveryKitDenial =
	/** `sealedMail` is off on this instance. */
	| 'feature_off'
	/** The address is not one the caller sends as. */
	| 'not_your_address'
	/** Too many recent failed re-authentications. */
	| 'throttled'
	/** The re-prompt password did not match. */
	| 'bad_password'
	/** The address has no active sealing key to export. */
	| 'no_key';

export type RecoveryKitGateResult<Kit> =
	| { ok: true; kit: Kit }
	| { ok: false; reason: RecoveryKitDenial };

/** Every effect the gate needs, injected so the ordering is testable without a database. */
export interface RecoveryKitGateDeps<Kit> {
	isFeatureEnabled: () => Promise<boolean>;
	/** Does the caller actually send as this address (own mailbox or alias)? */
	ownsAddress: () => Promise<boolean>;
	/** Have there been too many recent failed re-authentications for this caller? */
	isThrottled: () => Promise<boolean>;
	/** Verify the re-prompt password against the caller's own credentials. */
	verifyPassword: () => Promise<boolean>;
	/** Record a failed re-authentication (feeds {@link RecoveryKitGateDeps.isThrottled}). */
	recordFailure: () => Promise<void>;
	/** Assemble the kit. Returns null when the address holds no active key. */
	exportKit: () => Promise<Kit | null>;
}

/**
 * Run the four checks in order and, only on a clean pass, assemble the kit.
 *
 * Denials are returned rather than thrown so the caller can map them to honest,
 * non-leaky copy in one place. They are coarse on purpose: `not_your_address`
 * covers both "that address does not exist" and "it exists but is someone
 * else's", so the response is not an address-existence oracle for a session that
 * has been taken over.
 */
export async function guardRecoveryKitExport<Kit>(
	deps: RecoveryKitGateDeps<Kit>
): Promise<RecoveryKitGateResult<Kit>> {
	if (!(await deps.isFeatureEnabled())) return { ok: false, reason: 'feature_off' };
	if (!(await deps.ownsAddress())) return { ok: false, reason: 'not_your_address' };
	if (await deps.isThrottled()) return { ok: false, reason: 'throttled' };
	if (!(await deps.verifyPassword())) {
		await deps.recordFailure();
		return { ok: false, reason: 'bad_password' };
	}
	const kit = await deps.exportKit();
	if (!kit) return { ok: false, reason: 'no_key' };
	return { ok: true, kit };
}
