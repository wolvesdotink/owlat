import { describe, expect, it } from 'vitest';
import { parseCanonicalEhloHostnames } from '../outboundIdentity';

describe('parseCanonicalEhloHostnames', () => {
	it('accepts equivalent aliases with the same case-insensitive DNS name', () => {
		expect(
			parseCanonicalEhloHostnames(
				JSON.stringify({
					'2001:0DB8:0:0:0:0:0:10': 'Mail6.Example.com',
					'2001:db8::10': 'mail6.example.com',
				})
			)
		).toEqual({ '2001:db8::10': 'Mail6.Example.com' });
	});

	it('rejects conflicting canonical aliases and invalid unused entries', () => {
		expect(() =>
			parseCanonicalEhloHostnames(
				JSON.stringify({
					'2001:db8::10': 'mail6.example.com',
					'2001:0DB8:0:0:0:0:0:10': 'other.example.com',
				})
			)
		).toThrow(/conflicting names/);
		expect(() =>
			parseCanonicalEhloHostnames(
				JSON.stringify({
					'203.0.113.10': 'mail.example.com',
					'not-an-ip': 'unused.example.com',
				})
			)
		).toThrow(/not a valid bare IP/);
	});
});
