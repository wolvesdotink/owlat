/**
 * Unit tests for the scheduling-focused reply framing
 * (mail/ai.buildSchedulingInstruction): it asks for accept + alternative
 * options, references the sender's proposed times VERBATIM as untrusted data,
 * and bounds the list. Pure helper — no network.
 */
import { describe, it, expect } from 'vitest';
import { buildSchedulingInstruction } from '../ai';

describe('buildSchedulingInstruction', () => {
	it('asks for accept and alternative framings', () => {
		const out = buildSchedulingInstruction(['Tuesday afternoon']);
		expect(out).toContain('scheduling request');
		expect(out.toLowerCase()).toContain('accept');
		expect(out.toLowerCase()).toContain('alternative');
		// Advisory: never confirms a time as final.
		expect(out).toContain('Do not confirm');
	});

	it('lists the proposed times verbatim as untrusted data', () => {
		const out = buildSchedulingInstruction(['Tuesday afternoon', 'after 3pm']);
		expect(out).toContain('untrusted data');
		expect(out).toContain('- Tuesday afternoon');
		expect(out).toContain('- after 3pm');
	});

	it('drops empty phrases and caps the list at six', () => {
		const out = buildSchedulingInstruction([
			' a ',
			'',
			'   ',
			'b',
			'c',
			'd',
			'e',
			'f',
			'g',
		]);
		expect(out).toContain('- a');
		expect(out).toContain('- f');
		expect(out).not.toContain('- g');
	});

	it('omits the times section entirely when there are none', () => {
		const out = buildSchedulingInstruction([]);
		expect(out).toContain('scheduling request');
		expect(out).not.toContain('The sender proposed');
	});
});
