import { describe, expect, it } from 'vitest';
import { normalizeDomain } from '../normalizeDomain';

describe('normalizeDomain', () => {
	it('lowercases, trims, and strips a single trailing root dot', () => {
		expect(normalizeDomain('  Google.COM.  ')).toBe('google.com');
		expect(normalizeDomain('example.com..')).toBe('example.com.');
	});

	it('treats a missing domain as the empty string', () => {
		expect(normalizeDomain(undefined)).toBe('');
		expect(normalizeDomain(null)).toBe('');
		expect(normalizeDomain('   ')).toBe('');
	});

	it('leaves ASCII input alone beyond case and the root dot', () => {
		expect(normalizeDomain('pass')).toBe('pass');
		expect(normalizeDomain('xn--bcher-kva.example')).toBe('xn--bcher-kva.example');
		expect(normalizeDomain('mail.example.com:25')).toBe('mail.example.com:25');
		expect(normalizeDomain('192.0.2.1')).toBe('192.0.2.1');
	});

	it('converts internationalized names to their IDNA ASCII form', () => {
		expect(normalizeDomain('Bücher.example.')).toBe('xn--bcher-kva.example');
		expect(normalizeDomain('münchen.de')).toBe('xn--mnchen-3ya.de');
		expect(normalizeDomain('mail.北京.cn')).toBe('mail.xn--1lq90i.cn');
	});

	it('keeps the lowercased spelling when the URL parser cannot take the whole name', () => {
		expect(normalizeDomain('bücher.example:25')).toBe('bücher.example:25');
		expect(normalizeDomain('bücher.example/path')).toBe('bücher.example/path');
		expect(normalizeDomain('user@bücher.example')).toBe('user@bücher.example');
		expect(normalizeDomain('bü cher.example')).toBe('bü cher.example');
	});
});
