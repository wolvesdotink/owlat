/**
 * Unit tests for the scheduling-focused reply framing
 * (mail/aiScheduling.buildSchedulingInstruction): it asks for accept + alternative
 * options, references the sender's proposed times VERBATIM as untrusted data,
 * and bounds the list. Pure helper — no network.
 */
import { describe, it, expect } from 'vitest';
import { buildSchedulingInstruction } from '../aiScheduling';

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

	it('with no open slots, keeps the "never invent availability" guard (unchanged)', () => {
		const out = buildSchedulingInstruction(['Tuesday afternoon']);
		expect(out).toContain('never invent calendar availability');
		expect(out).not.toContain('from their own calendar');
	});

	it('grounds concrete open slots from the owner calendar as trusted data', () => {
		const out = buildSchedulingInstruction(
			['Tuesday afternoon'],
			['Tue, Jul 8, 2:00 PM', 'Wed, Jul 9, 10:00 AM'],
		);
		expect(out).toContain('from their own calendar');
		expect(out).toContain('- Tue, Jul 8, 2:00 PM');
		expect(out).toContain('- Wed, Jul 9, 10:00 AM');
		// Grounded mode swaps the "never invent" guard for "propose the open times".
		expect(out).toContain("propose one or two of the user's open times");
		expect(out).not.toContain('never invent calendar availability');
	});

	it('caps the open-slot list at three', () => {
		const out = buildSchedulingInstruction(
			[],
			['s1', 's2', 's3', 's4'],
		);
		expect(out).toContain('- s1');
		expect(out).toContain('- s3');
		expect(out).not.toContain('- s4');
	});
});
