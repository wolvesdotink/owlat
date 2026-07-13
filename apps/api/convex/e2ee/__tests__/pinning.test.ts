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
