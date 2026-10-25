import { describe, expect, it } from 'vitest';
import {
	arrayOf,
	boolean,
	decodeJson,
	integer,
	JsonShapeError,
	literal,
	nullable,
	number,
	object,
	oneOf,
	optional,
	parseJson,
	record,
	recordOf,
	string,
} from '../json';

const decodeEntry = object({
	name: string,
	size: integer,
	tags: arrayOf(string),
	note: optional(string),
	owner: nullable(object({ id: string })),
});

const shapeError = (run: () => unknown): string => {
	try {
		run();
	} catch (error) {
		expect(error).toBeInstanceOf(JsonShapeError);
		return (error as Error).message;
	}
	throw new Error('expected a JsonShapeError');
};

describe('the scripts JSON decoders', () => {
	it('accept a well-formed value and keep the fields nobody declared', () => {
		const text = '{"name":"web","size":3,"tags":["a"],"owner":null,"context":"."}';
		const entry = decodeJson(text, decodeEntry, 'entry');
		expect(entry).toEqual({ name: 'web', size: 3, tags: ['a'], owner: null, context: '.' });
		expect('note' in entry).toBe(false);
	});

	it('refuse valid JSON that is not the declared shape', () => {
		for (const text of ['null', '42', '"web"', 'true', '[]', '[{"name":"web"}]']) {
			expect(shapeError(() => decodeJson(text, decodeEntry, 'entry'))).toBe(
				'entry must be an object'
			);
		}
	});

	it('name the path of a missing or mistyped field, nested ones included', () => {
		const base = { name: 'web', size: 3, tags: ['a'], owner: null };
		const cases: [unknown, string][] = [
			[{ ...base, name: undefined }, 'entry.name must be a string'],
			[{ ...base, size: '3' }, 'entry.size must be an integer'],
			[{ ...base, size: 1.5 }, 'entry.size must be an integer'],
			[{ ...base, tags: 'a' }, 'entry.tags must be an array'],
			[{ ...base, tags: ['a', 7] }, 'entry.tags[1] must be a string'],
			[{ ...base, note: 7 }, 'entry.note must be a string'],
			[{ ...base, owner: { id: 7 } }, 'entry.owner.id must be a string'],
			[{ ...base, owner: [] }, 'entry.owner must be an object'],
		];
		for (const [value, message] of cases) {
			expect(shapeError(() => decodeJson(JSON.stringify(value), decodeEntry, 'entry'))).toBe(
				message
			);
		}
	});

	it('refuse malformed text without quoting it', () => {
		const message = shapeError(() => parseJson('{"secret":"s3cr3t",', 'secrets.json'));
		expect(message).toBe('secrets.json is not valid JSON');
		expect(message).not.toContain('s3cr3t');
	});

	it('never put the offending value into an error', () => {
		const message = shapeError(() =>
			decodeJson('{"token":{"value":"s3cr3t"}}', object({ token: string }), 'answer')
		);
		expect(message).toBe('answer.token must be a string');
	});

	it('check every member of a map and every alternative of a field', () => {
		expect(decodeJson('{"a":"1","b":"2"}', recordOf(string), 'map')).toEqual({ a: '1', b: '2' });
		expect(shapeError(() => decodeJson('{"a":"1","b":2}', recordOf(string), 'map'))).toBe(
			'map.b must be a string'
		);
		expect(shapeError(() => decodeJson('["a"]', recordOf(string), 'map'))).toBe(
			'map must be an object'
		);
		expect(shapeError(() => decodeJson('[]', record, 'row'))).toBe('row must be an object');
		const keyed = decodeJson('{"__proto__":"x"}', recordOf(string), 'map');
		expect(Object.keys(keyed)).toEqual(['__proto__']);
		expect(Object.getPrototypeOf(keyed)).toBe(Object.prototype);

		const either = oneOf<string | number>('a string or a number', string, number);
		expect(either('a', 'x')).toBe('a');
		expect(either(1, 'x')).toBe(1);
		expect(shapeError(() => either(true, 'x'))).toBe('x must be a string or a number');
		expect(shapeError(() => number(Number.NaN, 'n'))).toBe('n must be a finite number');
		expect(shapeError(() => boolean('true', 'b'))).toBe('b must be a boolean');
		expect(literal('data', 'dot')('dot', 'p')).toBe('dot');
		expect(shapeError(() => literal('data', 'dot')('body', 'p'))).toBe(
			'p must be one of data, dot'
		);
	});
});
