/**
 * Enumerated, signed-off divergences between the in-house SMTP listener and the
 * `smtp-server` oracle (I2 — every intended behaviour change is enumerated in a
 * fixture and individually signed off, NEVER discovered live).
 *
 * The parity harness (`parity.test.ts`) drives byte-identical scripted
 * conversations against BOTH a real `smtp-server` and our listener and asserts
 * the reply-code sequences are equal EXCEPT at the positions enumerated here.
 * Two classes of sanctioned divergence exist:
 *
 *  - {@link EnhancedCodeEnrichment}: the BASE reply code is identical to
 *    `smtp-server`; we additionally emit the correct RFC 3463 enhanced status
 *    code where the oracle omits it (I2(c) — "corrected/real SMTP enhanced
 *    status codes"). The oracle's reply carries no enhanced code, ours does.
 *
 *  - {@link BaseCodeDivergence}: the BASE reply code itself differs. Only the
 *    AUTH-failure family diverges at the base-code level, and only to uphold the
 *    no-auth-oracle rule (D6/I5 — every AUTH failure is byte-identical, so a
 *    probe cannot tell which stage was wrong) plus the real-enhanced-code
 *    improvement. Each is already pinned by `auth.test.ts`; it is re-declared
 *    here so the parity table can allow it explicitly rather than trip on it.
 *
 * This module is a fixture, not a test file (no `*.test.ts` suffix), so vitest's
 * `include` glob skips it and the package tsconfig excludes `__tests__`.
 */

/**
 * A reply where our base code matches `smtp-server` but we add the RFC 3463
 * enhanced status code the oracle omits. `linePattern` is asserted against OUR
 * reply line; the oracle's line is asserted NOT to carry the enhanced code.
 */
export interface EnhancedCodeEnrichment {
	readonly id: string;
	/** The scripted step (client command) whose reply is enriched. */
	readonly step: string;
	/** Base reply code, identical on both stacks. */
	readonly code: number;
	/** RFC 3463 enhanced code we emit (the oracle emits none for this reply). */
	readonly enhanced: string;
	/** Sign-off reference. */
	readonly rationale: string;
}

/**
 * A reply where the base code itself diverges from `smtp-server`. Confined to
 * the AUTH-failure family (D6 no-auth-oracle + real enhanced codes).
 */
export interface BaseCodeDivergence {
	readonly id: string;
	readonly step: string;
	/** `smtp-server`'s base reply code for this step. */
	readonly oracleCode: number;
	/** Our base reply code for this step. */
	readonly ourCode: number;
	/** RFC 3463 enhanced code we emit. */
	readonly ourEnhanced: string;
	readonly rationale: string;
}

/**
 * The enhanced-code enrichments (I2(c)). Base codes are byte-identical to
 * `smtp-server`; these enumerate the extra RFC 3463 code we attach so the parity
 * table can assert it is present on our side and absent on the oracle's.
 */
export const ENHANCED_CODE_ENRICHMENTS: readonly EnhancedCodeEnrichment[] = [
	{
		id: 'mail-from-ok',
		step: 'MAIL FROM',
		code: 250,
		enhanced: '2.1.0',
		rationale:
			'I2(c): RFC 3463 2.1.0 (originator address ok); smtp-server emits bare "250 Accepted".',
	},
	{
		id: 'rcpt-to-ok',
		step: 'RCPT TO',
		code: 250,
		enhanced: '2.1.5',
		rationale:
			'I2(c): RFC 3463 2.1.5 (destination address valid); smtp-server emits bare "250 Accepted".',
	},
	{
		id: 'data-accepted',
		step: 'DATA body',
		code: 250,
		enhanced: '2.0.0',
		rationale:
			'I2(c): RFC 3463 2.0.0 (other/undefined status); smtp-server emits bare "250 OK: message queued".',
	},
	{
		id: 'message-too-large',
		step: 'oversize DATA body',
		code: 552,
		enhanced: '5.3.4',
		rationale:
			'I2(c): RFC 3463 5.3.4 (message too big for system); smtp-server emits bare "552 ...".',
	},
	{
		id: 'quit',
		step: 'QUIT',
		code: 221,
		enhanced: '2.0.0',
		rationale: 'I2(c): RFC 3463 2.0.0 on the closing reply; smtp-server emits bare "221 Bye".',
	},
] as const;

/**
 * The base-code divergences — the AUTH-failure family only. Every AUTH failure
 * collapses to ONE `535 5.7.8` regardless of the stage that failed
 * (unsupported mechanism, malformed base64, client cancel, rejected
 * credentials) and pre-TLS AUTH is refused with the modern `530 5.7.0`. Both
 * uphold the no-auth-oracle rule (D6/I5); `smtp-server` instead leaks the stage
 * via distinct codes (504 / 501 / 538). All are pinned by `auth.test.ts`.
 */
export const AUTH_BASE_CODE_DIVERGENCES: readonly BaseCodeDivergence[] = [
	{
		id: 'auth-pre-tls-refused',
		step: 'AUTH before STARTTLS',
		oracleCode: 538,
		ourCode: 530,
		ourEnhanced: '5.7.0',
		rationale:
			'D6/RFC 4954 §4: encryption required. 530 5.7.0 is the modern code; smtp-server replies 538.',
	},
	{
		id: 'auth-bad-mechanism',
		step: 'AUTH <unsupported-mechanism>',
		oracleCode: 504,
		ourCode: 535,
		ourEnhanced: '5.7.8',
		rationale:
			'D6 no-auth-oracle: an unsupported mechanism fails identically to bad credentials (535 5.7.8); smtp-server leaks it as 504.',
	},
	{
		id: 'auth-cancel-or-bad-base64',
		step: 'AUTH LOGIN cancelled (*) / malformed base64',
		oracleCode: 501,
		ourCode: 535,
		ourEnhanced: '5.7.8',
		rationale:
			'D6 no-auth-oracle: a client cancel (*) or malformed base64 fails identically to bad credentials (535 5.7.8); smtp-server leaks the stage as 501.',
	},
] as const;
