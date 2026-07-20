/**
 * Named test gate (c): the determinism gate M3 depends on. Given seeded
 * `date` + `boundarySeed` inputs (and an explicit Message-ID), `composeMessage`
 * is a pure function of its input — two calls produce BYTE-IDENTICAL output.
 * This is what makes a DKIM signature stable across MX retries (the message is
 * composed once and re-shipped unchanged) and what makes golden fixtures possible.
 */

import { describe, it, expect } from 'vitest';
import { composeMessage } from '../src/index';
import { CORPUS, toComposeInput } from './fixtures/corpus';

describe('composeMessage determinism (seeded date + boundary)', () => {
	for (const testCase of CORPUS) {
		it(`is byte-identical across two seeded calls: ${testCase.name}`, () => {
			const a = composeMessage(toComposeInput(testCase)).raw;
			const b = composeMessage(toComposeInput(testCase)).raw;
			expect(a.equals(b)).toBe(true);
		});
	}

	it('differs when the boundary seed differs (proving the seed drives the boundaries)', () => {
		const base = toComposeInput(CORPUS.find((c) => c.attachments && c.attachments.length > 0)!);
		const withInline = { ...base, boundarySeed: 'seed-one' };
		const withDifferent = { ...base, boundarySeed: 'seed-two' };
		expect(composeMessage(withInline).raw.equals(composeMessage(withDifferent).raw)).toBe(false);
	});

	it('generates a Message-ID when none is supplied, scoped to the From domain', () => {
		const { messageId } = composeMessage({
			from: 'sender@owlat.test',
			to: ['rcpt@example.com'],
			subject: 'no explicit id',
			html: '<p>x</p>',
			text: 'x',
			date: new Date('2026-07-11T00:00:00.000Z'),
			boundarySeed: 'gen',
		});
		expect(messageId).toMatch(/^<[^@]+@owlat\.test>$/);
	});
});
