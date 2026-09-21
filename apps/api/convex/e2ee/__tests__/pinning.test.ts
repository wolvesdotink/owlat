/**
 * TOFU pinning — the hard test gate for the trust state machine
 * (`e2ee/pinning.ts`). Pure: no keys, no network. Exercises every transition:
 *   pin (first use) / unchanged / signed-rotate / unsigned-change / re-accept,
 * plus the invariant that an unsigned key change NEVER silently re-pins.
 */

import { describe, it, expect } from 'vitest';
import {
	evaluatePin,
	reacceptObservedKey,
	normalizeFingerprint,
	fingerprintsEqual,
	isKeyVerified,
	resolveVerificationState,
} from '../pinning';

const OLD = 'AAAA1111BBBB2222CCCC3333DDDD4444EEEE5555';
const NEW = '9999888877776666555544443333222211110000';

describe('e2ee/pinning fingerprint helpers', () => {
	it('normalizes whitespace and case', () => {
		expect(normalizeFingerprint('aa bb cc')).toBe('AABBCC');
		expect(fingerprintsEqual('aa bb', 'AABB')).toBe(true);
		expect(fingerprintsEqual(OLD, NEW)).toBe(false);
	});
});

describe('e2ee/pinning state machine', () => {
	it('first use pins the observed key and is trusted', () => {
		const d = evaluatePin({
			pinnedFingerprint: null,
			observedFingerprint: NEW,
			rotationSignatureValid: false,
		});
		expect(d.action).toBe('firstUse');
		expect(d.pinnedFingerprint).toBe(NEW);
		expect(d.state).toBe('pinned');
		expect(d.trusted).toBe(true);
	});

	it('an empty pin string is treated as first use', () => {
		const d = evaluatePin({
			pinnedFingerprint: '',
			observedFingerprint: NEW,
			rotationSignatureValid: false,
		});
		expect(d.action).toBe('firstUse');
	});

	it('the same fingerprint (case/space-insensitive) is unchanged + trusted', () => {
		const d = evaluatePin({
			pinnedFingerprint: OLD,
			observedFingerprint: OLD.toLowerCase()
				.replace(/(....)/g, '$1 ')
				.trim(),
			rotationSignatureValid: false,
		});
		expect(d.action).toBe('unchanged');
		expect(d.pinnedFingerprint).toBe(OLD);
		expect(d.state).toBe('pinned');
		expect(d.trusted).toBe(true);
	});

	it('a signed rotation silently upgrades the pin to the new key', () => {
		const d = evaluatePin({
			pinnedFingerprint: OLD,
			observedFingerprint: NEW,
			rotationSignatureValid: true,
		});
		expect(d.action).toBe('signedRotation');
		expect(d.pinnedFingerprint).toBe(NEW);
		expect(d.state).toBe('pinned');
		expect(d.trusted).toBe(true);
	});

	it('an UNSIGNED key change never re-pins — keeps the old pin, flags keyChanged, untrusted', () => {
		const d = evaluatePin({
			pinnedFingerprint: OLD,
			observedFingerprint: NEW,
			rotationSignatureValid: false,
		});
		expect(d.action).toBe('keyChanged');
		expect(d.pinnedFingerprint).toBe(OLD); // pin is NOT advanced
		expect(d.observedFingerprint).toBe(NEW); // conflicting key rides along
		expect(d.state).toBe('keyChanged');
		expect(d.trusted).toBe(false);
	});

	it('an explicit re-accept adopts the observed key as the new pin', () => {
		const d = reacceptObservedKey(NEW);
		expect(d.action).toBe('reaccept');
		expect(d.pinnedFingerprint).toBe(NEW);
		expect(d.state).toBe('pinned');
		expect(d.trusted).toBe(true);
	});
});

/**
 * Human verification (plan idea 54) sits ON TOP of the pin: TOFU says which key
 * we seal to, verification says a person compared that key with its owner. The
 * property under test is that the claim can never outlive the key it was about —
 * it is stored as the CHECKED FINGERPRINT, so a rotation invalidates it with no
 * sweep and no migration.
 */
describe('e2ee/pinning verification state', () => {
	it('reads as unverified when nobody has checked', () => {
		expect(resolveVerificationState({ pinnedFingerprint: OLD })).toBe('unverified');
		expect(resolveVerificationState({ pinnedFingerprint: OLD, verifiedFingerprint: null })).toBe(
			'unverified'
		);
		expect(isKeyVerified({ pinnedFingerprint: OLD })).toBe(false);
	});

	it('reads as verified when the checked key is still the pinned one', () => {
		expect(resolveVerificationState({ pinnedFingerprint: OLD, verifiedFingerprint: OLD })).toBe(
			'verified'
		);
		expect(isKeyVerified({ pinnedFingerprint: OLD, verifiedFingerprint: OLD })).toBe(true);
	});

	it('ignores spacing and case, exactly as the pin comparison does', () => {
		expect(
			isKeyVerified({
				pinnedFingerprint: OLD,
				verifiedFingerprint: OLD.toLowerCase().replace(/(.{4})/g, '$1 '),
			})
		).toBe(true);
	});

	it('goes stale — never silently verified — the moment the pin moves', () => {
		expect(resolveVerificationState({ pinnedFingerprint: NEW, verifiedFingerprint: OLD })).toBe(
			'stale'
		);
		expect(isKeyVerified({ pinnedFingerprint: NEW, verifiedFingerprint: OLD })).toBe(false);
	});

	it('treats a checked key with no pin at all as stale, not verified', () => {
		expect(resolveVerificationState({ verifiedFingerprint: OLD })).toBe('stale');
		expect(resolveVerificationState({ pinnedFingerprint: null, verifiedFingerprint: OLD })).toBe(
			'stale'
		);
	});
});
