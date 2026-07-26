import { describe, expect, it } from 'vitest';
import {
	createDeliverabilityProbeToken,
	isDeliverabilityProbeTokenFormat,
	verifyDeliverabilityProbeToken,
} from '../deliverabilityProbeToken';

const SECRET = 'test-webhook-secret';
const NOW = 1_800_000_000_000;
const MIXED_CASE_NONCE = Buffer.from([0, 16, 131, 8, 81, 135, 24, 146, 141]);

describe('deliverability probe tokens', () => {
	it('creates a valid mixed-case, local-part-safe token', () => {
		const token = createDeliverabilityProbeToken(SECRET, NOW + 15 * 60_000, MIXED_CASE_NONCE);
		expect(token).toMatch(/[A-Z]/);
		expect(isDeliverabilityProbeTokenFormat(token)).toBe(true);
		expect(`deliverability-probe+${token}`.length).toBeLessThanOrEqual(64);
		expect(verifyDeliverabilityProbeToken(token, SECRET, NOW)).toBe(true);
	});

	it('rejects a forged MAC and expired token', () => {
		const token = createDeliverabilityProbeToken(SECRET, NOW + 60_000, MIXED_CASE_NONCE);
		const forged = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
		expect(verifyDeliverabilityProbeToken(forged, SECRET, NOW)).toBe(false);
		expect(verifyDeliverabilityProbeToken(token, SECRET, NOW + 61_000)).toBe(false);
	});
});
