import { describe, expect, it } from 'vitest';
import {
	CONDITION_REGION_END,
	REPEAT_REGION_END,
	conditionRegionStart,
	evaluateBlockCondition,
	hasSendRegions,
	repeatVariablesIn,
	repeatRegionStart,
	resolveSendRegions,
	stripSendRegionMarkers,
} from '../sendRegions';
import type { BlockCondition, BlockRepeat } from '../types';

const ifRegion = (condition: BlockCondition, body: string) =>
	`${conditionRegionStart(condition)}${body}${CONDITION_REGION_END}`;
const eachRegion = (repeat: BlockRepeat, body: string) =>
	`${repeatRegionStart(repeat)}${body}${REPEAT_REGION_END}`;

/** Fills a segment by showing which repeat entry it belongs to. */
const tagged = (
	segment: string,
	item: { index: number; fields: Record<string, unknown> } | undefined
) => (item ? segment.replace('#', `${item.index}:${String(item.fields['name'] ?? '')}`) : segment);

describe('evaluateBlockCondition', () => {
	const exists = { variable: 'v', operator: 'exists' } as const;
	const notExists = { variable: 'v', operator: 'notExists' } as const;

	it('treats a missing variable, null and the empty string as absent', () => {
		for (const variables of [{}, { v: null }, { v: '' }]) {
			expect(evaluateBlockCondition(exists, variables)).toBe(false);
			expect(evaluateBlockCondition(notExists, variables)).toBe(true);
		}
	});

	it('treats false, 0 and an empty list as present, as the preview reads their text', () => {
		for (const v of [false, 0, [], 'false', '0', '[]']) {
			expect(evaluateBlockCondition(exists, { v })).toBe(true);
			expect(evaluateBlockCondition(notExists, { v })).toBe(false);
		}
	});

	it('compares numbers and booleans as their text', () => {
		expect(
			evaluateBlockCondition({ variable: 'v', operator: 'equals', value: '5' }, { v: 5 })
		).toBe(true);
		expect(
			evaluateBlockCondition({ variable: 'v', operator: 'notEquals', value: 'true' }, { v: true })
		).toBe(false);
		expect(
			evaluateBlockCondition({ variable: 'v', operator: 'contains', value: 'VIP' }, { v: 'is VIP' })
		).toBe(true);
		expect(evaluateBlockCondition({ variable: 'v', operator: 'contains', value: 'x' }, {})).toBe(
			false
		);
	});
});

describe('the list a repeat iterates', () => {
	it('is the list the request sent, and never text holding one', () => {
		const body = eachRegion({ variable: 'v', itemAlias: 'i' }, '#;');
		const resolve = (v: unknown) => resolveSendRegions(body, { v }, tagged);
		expect(resolve([1, { name: 'a' }])).toBe('0:;1:a;');
		for (const v of ['[{"name":"a"}]', '{"a":1}', undefined, 3]) expect(resolve(v)).toBe('');
	});
});

describe('resolveSendRegions', () => {
	const hasCode = { variable: 'code', operator: 'exists' } as const;
	const lines = { variable: 'lines', itemAlias: 'line' };

	it('fills a body without markers whole, exactly as the fill makes it', () => {
		const body = '<p>Hello {{name}}</p>';
		expect(hasSendRegions(body)).toBe(false);
		expect(resolveSendRegions(body, {}, (segment) => `[${segment}]`)).toBe(`[${body}]`);
	});

	it('keeps or drops a conditional region and removes its markers', () => {
		const body = `A${ifRegion(hasCode, 'B')}C`;
		expect(resolveSendRegions(body, { code: 'x' }, (s) => s)).toBe('ABC');
		expect(resolveSendRegions(body, {}, (s) => s)).toBe('AC');
	});

	it('writes a repeated region once per entry, up to maxItems', () => {
		const body = eachRegion({ ...lines, maxItems: 2 }, '<li>#</li>');
		const variables = { lines: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] };
		expect(resolveSendRegions(body, variables, tagged)).toBe('<li>0:a</li><li>1:b</li>');
	});

	it('writes nothing for an empty or missing list', () => {
		const body = `x${eachRegion(lines, '#')}y`;
		expect(resolveSendRegions(body, { lines: [] }, tagged)).toBe('xy');
		expect(resolveSendRegions(body, {}, tagged)).toBe('xy');
	});

	it('resolves a repeat inside a condition and a condition inside a repeat', () => {
		const repeatInCondition = ifRegion(hasCode, eachRegion(lines, '#;'));
		const variables = { code: 'x', lines: [{ name: 'a' }, { name: 'b' }] };
		expect(resolveSendRegions(repeatInCondition, variables, tagged)).toBe('0:a;1:b;');
		expect(resolveSendRegions(repeatInCondition, { lines: variables.lines }, tagged)).toBe('');

		const conditionInRepeat = eachRegion(lines, `#${ifRegion(hasCode, '+')};`);
		expect(resolveSendRegions(conditionInRepeat, variables, tagged)).toBe('0:a+;1:b+;');
		expect(resolveSendRegions(conditionInRepeat, { lines: variables.lines }, tagged)).toBe(
			'0:a;1:b;'
		);
	});

	it('never reads a filled value as a marker', () => {
		const injected = `${CONDITION_REGION_END}${conditionRegionStart({ variable: 'nope', operator: 'exists' })}`;
		const body = `${ifRegion(hasCode, '{{v}}')}tail`;
		const out = resolveSendRegions(body, { code: 'x' }, (segment) =>
			segment.replace('{{v}}', injected)
		);
		expect(out).toBe(`${injected}tail`);
	});

	it('drops a closing marker without its opener and keeps an unclosed region', () => {
		expect(resolveSendRegions(`a${CONDITION_REGION_END}b`, {}, (s) => s)).toBe('ab');
		expect(resolveSendRegions(`a${conditionRegionStart(hasCode)}b`, {}, (s) => s)).toBe('ab');
	});

	it('shows a region whose condition does not decode', () => {
		expect(resolveSendRegions('a<!--owlat:if %7Bbroken-->b<!--owlat:endif-->', {}, (s) => s)).toBe(
			'ab'
		);
	});

	it('encodes a payload so it cannot end the comment', () => {
		const marker = conditionRegionStart({
			variable: 'x',
			operator: 'equals',
			value: 'a --> b -- c',
		});
		expect(marker.slice(4, -3)).not.toContain('--');
		expect(marker.slice(4, -3)).not.toContain('>');
		const body = ifRegion({ variable: 'x', operator: 'equals', value: 'a --> b -- c' }, 'yes');
		expect(resolveSendRegions(body, { x: 'a --> b -- c' }, (s) => s)).toBe('yes');
	});
});

describe('stripSendRegionMarkers', () => {
	it('removes every marker and keeps every region', () => {
		const body = `a${ifRegion({ variable: 'v', operator: 'exists' }, 'b')}${eachRegion({ variable: 'l', itemAlias: 'i' }, 'c')}`;
		expect(stripSendRegionMarkers(body)).toBe('abc');
	});
});

describe('repeatVariablesIn', () => {
	it('names the lists of the repeats a send keeps, not those inside a dropped condition', () => {
		const body = `${eachRegion({ variable: 'lines', itemAlias: 'l' }, 'x')}${ifRegion(
			{ variable: 'gift', operator: 'exists' },
			eachRegion({ variable: 'giftLines', itemAlias: 'g' }, 'y')
		)}`;
		expect(repeatVariablesIn(body, {})).toEqual(['lines']);
		expect(repeatVariablesIn(body, { gift: 'yes' })).toEqual(['lines', 'giftLines']);
		expect(repeatVariablesIn('<p>plain</p>', {})).toEqual([]);
	});
});

describe('resolveSendRegions options', () => {
	const lines = { variable: 'lines', itemAlias: 'l' };
	const variables = { lines: Array.from({ length: 400 }, (_, i) => ({ name: `n${i}` })) };

	it('writes a repeated region for its first entry only when asked', () => {
		const body = eachRegion(lines, '#;');
		expect(resolveSendRegions(body, variables, tagged, { firstEntryOnly: true })).toBe('0:n0;');
	});

	it('stops at maxLength instead of building the rest', () => {
		let filled = 0;
		const out = resolveSendRegions(
			eachRegion(lines, 'xxxxxxxxxx'),
			variables,
			(segment) => {
				filled++;
				return segment;
			},
			{ maxLength: 95 }
		);
		expect(out).toBeNull();
		expect(filled).toBe(10);
	});
});

describe('variable lookup', () => {
	it('reads only the variables the request sent, not Object.prototype', () => {
		expect(evaluateBlockCondition({ variable: 'constructor', operator: 'exists' }, {})).toBe(false);
		expect(
			resolveSendRegions(eachRegion({ variable: 'toString', itemAlias: 'i' }, 'x'), {}, (s) => s)
		).toBe('');
	});
});
