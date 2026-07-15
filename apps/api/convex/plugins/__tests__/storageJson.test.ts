import { describe, expect, it } from 'vitest';
import {
	decodePluginStorageValue,
	encodePluginStorageValue,
	InvalidPluginStorageValueError,
	PLUGIN_STORAGE_LIMITS,
	pluginStorageEntryBytes,
	validatePluginStorageKey,
} from '../storageJson';

describe('plugin storage JSON boundary', () => {
	it('canonicalizes object keys and round-trips JSON values deterministically', () => {
		const first = encodePluginStorageValue({ zebra: 1, alpha: ['ü', null, true], nested: {} });
		const second = encodePluginStorageValue({ nested: {}, alpha: ['ü', null, true], zebra: 1 });

		expect(first).toEqual(second);
		expect(first.json).toBe('{"alpha":["ü",null,true],"nested":{},"zebra":1}');
		expect(decodePluginStorageValue(first.json, first.version)).toEqual({
			alpha: ['ü', null, true],
			nested: {},
			zebra: 1,
		});
	});

	it('accounts for UTF-8 bytes rather than UTF-16 code units', () => {
		const ascii = encodePluginStorageValue('a'.repeat(10));
		const unicode = encodePluginStorageValue('😀'.repeat(10));

		expect(unicode.bytes - ascii.bytes).toBe(30);
		expect(() => validatePluginStorageKey('😀'.repeat(65))).toThrow();
		expect(validatePluginStorageKey('😀'.repeat(64))).toHaveLength(128);
		expect(pluginStorageEntryBytes('😀', unicode.bytes)).toBe(unicode.bytes + 4);
	});

	it('canonicalizes keys in explicit UTF-16 code-unit order', () => {
		// The non-BMP key starts with a high surrogate, which sorts before U+E000
		// in JavaScript's UTF-16 ordering even though its Unicode code point is larger.
		expect(encodePluginStorageValue({ '\ue000': 1, '😀': 2 }).json).toBe('{"😀":2,"\ue000":1}');
	});

	it('never evaluates getters or proxy get traps', () => {
		let getterReads = 0;
		const accessor = Object.defineProperty({}, 'secret', {
			enumerable: true,
			get() {
				getterReads += 1;
				return 'leak';
			},
		});
		expect(() => encodePluginStorageValue(accessor)).toThrow(InvalidPluginStorageValueError);
		expect(getterReads).toBe(0);

		let getTrapReads = 0;
		const proxy = new Proxy(
			{ safe: 'value' },
			{
				get(target, property, receiver) {
					getTrapReads += 1;
					return Reflect.get(target, property, receiver);
				},
			}
		);
		expect(encodePluginStorageValue(proxy).json).toBe('{"safe":"value"}');
		expect(getTrapReads).toBe(0);
	});

	it.each([
		['undefined', undefined],
		['NaN', Number.NaN],
		['infinity', Number.POSITIVE_INFINITY],
		['bigint', 1n],
		['date', new Date()],
		['undefined field', { value: undefined }],
		['array property', Object.assign([], { extra: true })],
		['lone surrogate', String.fromCharCode(0xd800)],
	])('rejects non-JSON or ambiguous input: %s', (_label, value) => {
		expect(() => encodePluginStorageValue(value)).toThrow(InvalidPluginStorageValueError);
	});

	it('normalizes hostile reflection traps without reading values', () => {
		for (const trap of ['getPrototypeOf', 'ownKeys', 'getOwnPropertyDescriptor'] as const) {
			let getTrapReads = 0;
			const value = new Proxy(
				{ safe: true },
				{
					get() {
						getTrapReads += 1;
						return true;
					},
					[trap]() {
						throw new Error('hostile trap');
					},
				}
			);
			expect(() => encodePluginStorageValue(value)).toThrow(InvalidPluginStorageValueError);
			expect(getTrapReads).toBe(0);
		}
	});

	it('enforces depth, node, array, object, and value-byte bounds', () => {
		let deep: unknown = null;
		for (let index = 0; index <= PLUGIN_STORAGE_LIMITS.maxJsonDepth; index += 1) deep = [deep];
		expect(() => encodePluginStorageValue(deep)).toThrow(InvalidPluginStorageValueError);
		expect(() =>
			encodePluginStorageValue(Array(PLUGIN_STORAGE_LIMITS.maxArrayItems + 1).fill(null))
		).toThrow(InvalidPluginStorageValueError);
		expect(() =>
			encodePluginStorageValue(
				Object.fromEntries(
					Array.from({ length: PLUGIN_STORAGE_LIMITS.maxObjectFields + 1 }, (_, index) => [
						`k${index}`,
						null,
					])
				)
			)
		).toThrow(InvalidPluginStorageValueError);
		expect(() => encodePluginStorageValue('x'.repeat(PLUGIN_STORAGE_LIMITS.maxValueBytes))).toThrow(
			InvalidPluginStorageValueError
		);
	});

	it('rejects malformed, stale-version, and non-canonical persisted JSON', () => {
		expect(() => decodePluginStorageValue('{', 1)).toThrow(InvalidPluginStorageValueError);
		expect(() => decodePluginStorageValue('{}', undefined)).toThrow(InvalidPluginStorageValueError);
		expect(() => decodePluginStorageValue('{"z":1,"a":2}', 1)).toThrow(
			InvalidPluginStorageValueError
		);
	});
});
