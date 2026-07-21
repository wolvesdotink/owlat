import { describe, expect, it } from 'vitest';
import { strictestOutboundTlsMode, type OutboundTlsMode } from '../outboundTlsMode';

describe('strictestOutboundTlsMode', () => {
	it.each<[OutboundTlsMode, OutboundTlsMode, OutboundTlsMode]>([
		['opportunistic', 'opportunistic', 'opportunistic'],
		['opportunistic', 'require', 'require'],
		['opportunistic', 'require-verified', 'require-verified'],
		['require', 'opportunistic', 'require'],
		['require', 'require', 'require'],
		['require', 'require-verified', 'require-verified'],
		['require-verified', 'opportunistic', 'require-verified'],
		['require-verified', 'require', 'require-verified'],
		['require-verified', 'require-verified', 'require-verified'],
	])('returns %s ⊔ %s as %s', (first, second, expected) => {
		expect(strictestOutboundTlsMode(first, second)).toBe(expected);
	});
});
