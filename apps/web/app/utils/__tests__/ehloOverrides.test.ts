import { describe, expect, it } from 'vitest';
import { ehloHostnamesValue, ehloRowProblem } from '../ehloOverrides';

describe('ehloRowProblem', () => {
	it('accepts a bare IP and a full hostname, and ignores a blank row', () => {
		expect(ehloRowProblem({ ip: '203.0.113.11', hostname: 'mail2.example.com' })).toBeNull();
		expect(ehloRowProblem({ ip: '2001:db8::10', hostname: 'mail6.example.com' })).toBeNull();
		expect(ehloRowProblem({ ip: '', hostname: '' })).toBeNull();
	});

	it('names the field that is wrong', () => {
		expect(ehloRowProblem({ ip: 'mail.example.com', hostname: 'mail.example.com' })).toBe('ip');
		expect(ehloRowProblem({ ip: '203.0.113.11', hostname: 'localhost' })).toBe('hostname');
		expect(ehloRowProblem({ ip: '203.0.113.11', hostname: '' })).toBe('hostname');
	});
});

describe('ehloHostnamesValue', () => {
	it('builds the JSON map the MTA reads, skipping blank rows', () => {
		expect(
			ehloHostnamesValue([
				{ ip: '203.0.113.10', hostname: 'mail1.example.com' },
				{ ip: '', hostname: '' },
				{ ip: ' 203.0.113.11 ', hostname: 'mail2.example.com ' },
			])
		).toBe('{"203.0.113.10":"mail1.example.com","203.0.113.11":"mail2.example.com"}');
	});

	it('hands over nothing while a row is invalid or the table is empty', () => {
		expect(ehloHostnamesValue([{ ip: '', hostname: '' }])).toBeNull();
		expect(ehloHostnamesValue([{ ip: 'nope', hostname: 'mail.example.com' }])).toBeNull();
	});

	it('refuses two spellings of one address with different names', () => {
		expect(
			ehloHostnamesValue([
				{ ip: '2001:db8::10', hostname: 'a.example.com' },
				{ ip: '2001:0db8::10', hostname: 'b.example.com' },
			])
		).toBeNull();
	});
});
