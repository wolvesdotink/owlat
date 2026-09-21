import { describe, it, expect } from 'vitest';
import {
	senderAuthLine,
	senderAuthTone,
	senderCountLine,
	senderSearchLink,
	senderSearchQuery,
	type SenderAuthFacts,
} from '../postboxSenderProfile';
import { parseSearchQuery } from '../postboxSearchQuery';
import { createTestI18n } from '~/__tests__/i18n';

const { t } = createTestI18n().global;

function auth(over: Partial<SenderAuthFacts> = {}): SenderAuthFacts {
	return { verdict: 'pass', checked: 12, passed: 12, latest: { dmarc: 'pass' }, ...over };
}

describe('senderSearchQuery', () => {
	it('builds a from: query the search grammar actually parses back', () => {
		const query = senderSearchQuery('Ines@Northwind.Studio');
		expect(query).toBe('from:ines@northwind.studio');
		expect(parseSearchQuery(query).from).toBe('ines@northwind.studio');
	});

	it('quotes an address with whitespace so the operand is not cut short', () => {
		const query = senderSearchQuery('weird address@x.example');
		expect(query).toBe('from:"weird address@x.example"');
		expect(parseSearchQuery(query).from).toBe('weird address@x.example');
	});

	it('points the link at the search route', () => {
		expect(senderSearchLink('a@b.example')).toEqual({
			path: '/dashboard/postbox/search',
			query: { q: 'from:a@b.example' },
		});
	});
});

describe('senderAuthLine', () => {
	it('has a translation for every line it can produce', () => {
		const cases = [
			auth(),
			auth({ verdict: 'mixed', passed: 9 }),
			auth({ verdict: 'unknown', checked: 0, passed: 0, latest: null }),
			auth({ latest: { dmarc: 'pass', arcSealer: 'lists.example' } }),
		];
		for (const facts of cases) {
			const line = senderAuthLine(facts);
			expect(t(line.key, line.params ?? {})).not.toBe(line.key);
		}
	});

	it('says nothing was checked rather than implying a pass', () => {
		const line = senderAuthLine(auth({ verdict: 'unknown', checked: 0, passed: 0, latest: null }));
		expect(line.key).toMatch(/unknown$/);
		expect(senderAuthTone(auth({ verdict: 'unknown' }))).toBe('muted');
	});

	it('treats a verdict with zero checked messages as unknown, whatever it claims', () => {
		// Belt and braces: a `pass` verdict over an empty sample is not a pass.
		expect(senderAuthLine(auth({ verdict: 'pass', checked: 0, passed: 0 })).key).toMatch(
			/unknown$/
		);
	});

	it('names the forwarder when that is why it passes', () => {
		const line = senderAuthLine(auth({ latest: { dmarc: 'fail', arcSealer: 'lists.example' } }));
		expect(line.key).toMatch(/viaForwarder$/);
		expect(line.params).toEqual({ sealer: 'lists.example' });
	});

	it('counts the failures, not the passes, when the record is mixed', () => {
		const line = senderAuthLine(auth({ verdict: 'mixed', checked: 12, passed: 9 }));
		expect(line.key).toMatch(/mixed$/);
		expect(line.params).toEqual({ failed: 3, checked: 12 });
		expect(senderAuthTone(auth({ verdict: 'mixed' }))).toBe('warn');
	});
});

describe('senderCountLine', () => {
	it('presents a capped scan as a floor, never as a total', () => {
		expect(senderCountLine(250, true).key).toMatch(/messagesAtLeast$/);
		expect(senderCountLine(41, false).key).toMatch(/messages$/);
		const capped = senderCountLine(250, true);
		expect(t(capped.key, capped.params ?? {})).not.toBe(capped.key);
	});
});
