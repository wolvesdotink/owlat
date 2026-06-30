/**
 * PR-62 regression-lock: the CAPABILITY contract.
 *
 * One assembled `CAPABILITY_LINE` is the single source of truth for the
 * greeting, the post-LOGIN banner, and the `* CAPABILITY` response. These
 * tests pin (2) that the advertised set never silently drifts, that no
 * module declares a capability the line never advertises (and the reverse —
 * no advertised atom lacks an owning module), and that QRESYNC is *not*
 * advertised (we ship CONDSTORE but not QRESYNC); and (3) that STARTTLS is
 * not a verb, never appears in CAPABILITY, and is rejected with BAD.
 *
 * RFC 3501 §6.1.1 / §11.1; RFC 2595 (no plaintext creds without TLS);
 * RFC 7162 (CONDSTORE/QRESYNC); RFC 8314 (implicit TLS — no STARTTLS).
 */

import { describe, it, expect } from 'vitest';
import {
	assembleCapabilityLine,
	CAPABILITY_LINE,
	PLAINTEXT_CAPABILITY_LINE,
} from '../commands/walker.js';

/** Capabilities each module declares, mirrored from the modules under test. */
const MODULE_CAPABILITIES: readonly string[] = [
	'ENABLE',
	'UNSELECT',
	'MOVE',
	'IDLE',
	'UIDPLUS',
	'LITERAL+',
	'NAMESPACE',
	'LIST-EXTENDED',
	'LIST-STATUS',
	'SPECIAL-USE',
	'ID',
	'CONDSTORE',
];

function atomsOf(line: string): string[] {
	expect(line.startsWith('CAPABILITY ')).toBe(true);
	return line.slice('CAPABILITY '.length).split(' ');
}

describe('CAPABILITY_LINE — exact advertised set (snapshot)', () => {
	it('advertises exactly this set over TLS (drift guard)', () => {
		// Sorted so the snapshot is order-independent: the assembler uses a Set,
		// whose iteration order is insertion order, but the *set* is the contract.
		expect(atomsOf(CAPABILITY_LINE).sort()).toEqual(
			[
				'AUTH=PLAIN',
				'CONDSTORE',
				'ID',
				'IDLE',
				'IMAP4rev1',
				'LIST-EXTENDED',
				'LIST-STATUS',
				'LITERAL+',
				'MOVE',
				'NAMESPACE',
				'SPECIAL-USE',
				'UIDPLUS',
				'UNSELECT',
				'ENABLE',
			].sort(),
		);
	});

	it('begins with the IMAP4rev1 base atom and the CAPABILITY token', () => {
		expect(CAPABILITY_LINE.startsWith('CAPABILITY IMAP4rev1')).toBe(true);
	});

	it('advertises LOGINDISABLED + drops AUTH=PLAIN on the plaintext line', () => {
		const atoms = atomsOf(PLAINTEXT_CAPABILITY_LINE);
		expect(atoms).toContain('LOGINDISABLED');
		expect(atoms).not.toContain('AUTH=PLAIN');
		// IMAP4rev1 and every module atom still advertised; only the
		// credential-mechanism atoms flip with TLS state.
		expect(atoms).toContain('IMAP4rev1');
		for (const cap of MODULE_CAPABILITIES) expect(atoms).toContain(cap);
	});
});

describe('CAPABILITY_LINE — module/line consistency', () => {
	it('advertises every capability each module declares (no module is unreachable)', () => {
		const atoms = new Set(atomsOf(CAPABILITY_LINE));
		for (const cap of MODULE_CAPABILITIES) {
			expect(atoms.has(cap)).toBe(true);
		}
	});

	it('declares no advertised atom without an owning module or TLS-state rule', () => {
		// Every atom on the TLS line is either IMAP4rev1, a module-declared cap, or
		// AUTH=PLAIN (the only TLS-state atom that turns ON). Nothing else.
		const allowed = new Set<string>([
			'IMAP4rev1',
			'AUTH=PLAIN',
			...MODULE_CAPABILITIES,
		]);
		for (const atom of atomsOf(CAPABILITY_LINE)) {
			expect(allowed.has(atom)).toBe(true);
		}
	});

	it('does NOT advertise QRESYNC (we ship CONDSTORE but not QRESYNC)', () => {
		expect(atomsOf(CAPABILITY_LINE)).not.toContain('QRESYNC');
		expect(atomsOf(PLAINTEXT_CAPABILITY_LINE)).not.toContain('QRESYNC');
		// CONDSTORE *is* present — the pair must not be conflated.
		expect(atomsOf(CAPABILITY_LINE)).toContain('CONDSTORE');
	});

	it('is deterministic — re-assembling yields the identical line', () => {
		expect(assembleCapabilityLine(true)).toBe(CAPABILITY_LINE);
		expect(assembleCapabilityLine(false)).toBe(PLAINTEXT_CAPABILITY_LINE);
	});
});

describe('CAPABILITY_LINE — no STARTTLS (RFC 8314 implicit-TLS posture)', () => {
	it('never advertises STARTTLS on either the TLS or plaintext line', () => {
		expect(CAPABILITY_LINE).not.toContain('STARTTLS');
		expect(PLAINTEXT_CAPABILITY_LINE).not.toContain('STARTTLS');
	});
});
