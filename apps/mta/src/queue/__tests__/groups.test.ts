import { describe, expect, it, vi } from 'vitest';
import { buildGroupKey, extractDomain, classifyIsp, engagementToPriority } from '../groups.js';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('buildGroupKey', () => {
	it('produces correct format with lowercased domain', () => {
		expect(buildGroupKey('transactional', 'Gmail.COM')).toBe('transactional:gmail.com');
	});
});

describe('extractDomain', () => {
	it('returns the domain part, lowercased', () => {
		expect(extractDomain('user@Example.COM')).toBe('example.com');
	});

	it('throws on invalid email (no @)', () => {
		expect(() => extractDomain('invalid-email')).toThrow('Invalid email address');
	});

	it('uses last @ for addresses with multiple @', () => {
		expect(extractDomain('user@middle@domain.com')).toBe('domain.com');
	});
});

describe('classifyIsp', () => {
	it.each([
		['gmail.com', 'gmail'],
		['googlemail.com', 'gmail'],
		['outlook.com', 'microsoft'],
		['hotmail.com', 'microsoft'],
		['live.com', 'microsoft'],
		['msn.com', 'microsoft'],
		['yahoo.com', 'yahoo'],
		['aol.com', 'yahoo'],
		['ymail.com', 'yahoo'],
		['yahoo.co.uk', 'yahoo'],
		['icloud.com', 'apple'],
		['me.com', 'apple'],
		['mac.com', 'apple'],
	])('classifies %s as %s', (domain, expected) => {
		expect(classifyIsp(domain)).toBe(expected);
	});

	it('returns "other" for unknown domains', () => {
		expect(classifyIsp('custom-domain.org')).toBe('other');
	});
});

describe('engagementToPriority', () => {
	it.each([
		[100, 1],
		[80, 1],
		[79, 2],
		[50, 2],
		[49, 3],
		[20, 3],
		[19, 4],
		[0, 4],
	])('score %d → priority %d', (score, expected) => {
		expect(engagementToPriority(score)).toBe(expected);
	});

	it('returns 3 for undefined', () => {
		expect(engagementToPriority(undefined)).toBe(3);
	});
});
