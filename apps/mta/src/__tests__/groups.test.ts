import { describe, it, expect } from 'vitest';
import { buildGroupKey, extractDomain, classifyIsp } from '../queue/groups.js';

describe('extractDomain', () => {
	it('should extract domain from a simple email', () => {
		expect(extractDomain('user@example.com')).toBe('example.com');
	});

	it('should lowercase the domain', () => {
		expect(extractDomain('user@GMAIL.COM')).toBe('gmail.com');
	});

	it('should handle subdomains', () => {
		expect(extractDomain('user@mail.example.co.uk')).toBe('mail.example.co.uk');
	});

	it('should use last @ for addresses with multiple @', () => {
		expect(extractDomain('"user@local"@example.com')).toBe('example.com');
	});

	it('should throw on invalid email (no @)', () => {
		expect(() => extractDomain('invalid-email')).toThrow('Invalid email address');
	});
});

describe('classifyIsp', () => {
	it('should classify Gmail domains', () => {
		expect(classifyIsp('gmail.com')).toBe('gmail');
		expect(classifyIsp('googlemail.com')).toBe('gmail');
	});

	it('should classify Microsoft domains', () => {
		expect(classifyIsp('outlook.com')).toBe('microsoft');
		expect(classifyIsp('hotmail.com')).toBe('microsoft');
		expect(classifyIsp('live.com')).toBe('microsoft');
		expect(classifyIsp('msn.com')).toBe('microsoft');
	});

	it('should classify Yahoo domains', () => {
		expect(classifyIsp('yahoo.com')).toBe('yahoo');
		expect(classifyIsp('aol.com')).toBe('yahoo');
		expect(classifyIsp('ymail.com')).toBe('yahoo');
		expect(classifyIsp('yahoo.co.uk')).toBe('yahoo');
	});

	it('should classify Apple domains', () => {
		expect(classifyIsp('icloud.com')).toBe('apple');
		expect(classifyIsp('me.com')).toBe('apple');
		expect(classifyIsp('mac.com')).toBe('apple');
	});

	it('should classify unknown domains as "other"', () => {
		expect(classifyIsp('example.com')).toBe('other');
		expect(classifyIsp('protonmail.com')).toBe('other');
	});

	it('should be case-insensitive', () => {
		expect(classifyIsp('GMAIL.COM')).toBe('gmail');
		expect(classifyIsp('Outlook.Com')).toBe('microsoft');
	});
});

describe('buildGroupKey', () => {
	it('should build pool:domain format', () => {
		expect(buildGroupKey('transactional', 'gmail.com')).toBe('transactional:gmail.com');
		expect(buildGroupKey('campaign', 'yahoo.com')).toBe('campaign:yahoo.com');
	});

	it('should lowercase the domain', () => {
		expect(buildGroupKey('transactional', 'GMAIL.COM')).toBe('transactional:gmail.com');
	});
});
