export interface TextChunkSink {
	write(chunk: string): Promise<void>;
	close(): Promise<void>;
	abort(reason?: unknown): Promise<void>;
}

export type JsonValueWriter = (sink: TextChunkSink) => Promise<void>;

type JsonObjectEntry = readonly [key: string, value: JsonValueWriter];
const JSON_STRING_SEGMENT_CODE_UNITS = 4 * 1024;

function asAsyncIterable<T>(values: Iterable<T> | AsyncIterable<T>): AsyncIterable<T> {
	if (Symbol.asyncIterator in values) return values;
	return {
		async *[Symbol.asyncIterator]() {
			yield* values;
		},
	};
}

function unicodeEscape(codeUnit: number): string {
	return `\\u${codeUnit.toString(16).padStart(4, '0')}`;
}

async function writeJsonString(sink: TextChunkSink, value: string): Promise<void> {
	await sink.write('"');
	let segment = '';
	const flush = async () => {
		if (!segment) return;
		await sink.write(segment);
		segment = '';
	};

	for (let index = 0; index < value.length; index += 1) {
		const codeUnit = value.charCodeAt(index);
		let encodedCharacter: string;
		switch (codeUnit) {
			case 0x08:
				encodedCharacter = '\\b';
				break;
			case 0x09:
				encodedCharacter = '\\t';
				break;
			case 0x0a:
				encodedCharacter = '\\n';
				break;
			case 0x0c:
				encodedCharacter = '\\f';
				break;
			case 0x0d:
				encodedCharacter = '\\r';
				break;
			case 0x22:
				encodedCharacter = '\\"';
				break;
			case 0x5c:
				encodedCharacter = '\\\\';
				break;
			default:
				if (codeUnit <= 0x1f) {
					encodedCharacter = unicodeEscape(codeUnit);
				} else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
					const nextCodeUnit = value.charCodeAt(index + 1);
					if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
						encodedCharacter = value.slice(index, index + 2);
						index += 1;
					} else {
						encodedCharacter = unicodeEscape(codeUnit);
					}
				} else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
					encodedCharacter = unicodeEscape(codeUnit);
				} else {
					encodedCharacter = value[index]!;
				}
		}
		if (segment.length + encodedCharacter.length > JSON_STRING_SEGMENT_CODE_UNITS) {
			await flush();
		}
		segment += encodedCharacter;
	}
	await flush();
	await sink.write('"');
}

function isOmittedObjectValue(value: unknown): boolean {
	return value === undefined || typeof value === 'function' || typeof value === 'symbol';
}

async function writeJsonCompatibleValue(
	sink: TextChunkSink,
	value: unknown,
	ancestors: WeakSet<object>
): Promise<boolean> {
	if (isOmittedObjectValue(value)) return false;
	if (value === null) {
		await sink.write('null');
		return true;
	}
	switch (typeof value) {
		case 'string':
			await writeJsonString(sink, value);
			return true;
		case 'boolean':
			await sink.write(value ? 'true' : 'false');
			return true;
		case 'number':
			await sink.write(Number.isFinite(value) ? String(value) : 'null');
			return true;
		case 'bigint':
			throw new TypeError('Account export contains a bigint that cannot be serialized');
		case 'object':
			break;
		default:
			return false;
	}

	if (ancestors.has(value)) {
		throw new TypeError('Account export contains a circular value');
	}
	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			await sink.write('[');
			for (let index = 0; index < value.length; index += 1) {
				if (index > 0) await sink.write(',');
				if (!(await writeJsonCompatibleValue(sink, value[index], ancestors))) {
					await sink.write('null');
				}
			}
			await sink.write(']');
			return true;
		}

		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new TypeError('Account export contains a non-plain object');
		}
		await sink.write('{');
		let needsComma = false;
		for (const key in value) {
			if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
			const propertyValue = (value as Record<string, unknown>)[key];
			if (isOmittedObjectValue(propertyValue)) continue;
			if (needsComma) await sink.write(',');
			await writeJsonString(sink, key);
			await sink.write(':');
			await writeJsonCompatibleValue(sink, propertyValue, ancestors);
			needsComma = true;
		}
		await sink.write('}');
		return true;
	} finally {
		ancestors.delete(value);
	}
}

export function jsonValue(value: unknown): JsonValueWriter {
	return async (sink) => {
		if (!(await writeJsonCompatibleValue(sink, value, new WeakSet()))) {
			throw new TypeError('Account export contains a value that cannot be serialized');
		}
	};
}

export function jsonArray(
	items: Iterable<JsonValueWriter> | AsyncIterable<JsonValueWriter>
): JsonValueWriter {
	return async (sink) => {
		await sink.write('[');
		let needsComma = false;
		for await (const item of asAsyncIterable(items)) {
			if (needsComma) await sink.write(',');
			await item(sink);
			needsComma = true;
		}
		await sink.write(']');
	};
}

export function jsonObject(
	entries: Iterable<JsonObjectEntry> | AsyncIterable<JsonObjectEntry>
): JsonValueWriter {
	return async (sink) => {
		await sink.write('{');
		let needsComma = false;
		for await (const [key, value] of asAsyncIterable(entries)) {
			if (needsComma) await sink.write(',');
			await writeJsonString(sink, key);
			await sink.write(':');
			await value(sink);
			needsComma = true;
		}
		await sink.write('}');
	};
}

/** Writes a plain JSON object's opening brace and properties, but not its closing brace. */
export async function writeJsonObjectPropertiesPrefix(
	sink: TextChunkSink,
	value: Record<string, unknown>
): Promise<boolean> {
	await sink.write('{');
	const ancestors = new WeakSet<object>([value]);
	let hasProperties = false;
	for (const key in value) {
		if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
		const propertyValue = value[key];
		if (isOmittedObjectValue(propertyValue)) continue;
		if (hasProperties) await sink.write(',');
		await writeJsonString(sink, key);
		await sink.write(':');
		await writeJsonCompatibleValue(sink, propertyValue, ancestors);
		hasProperties = true;
	}
	return hasProperties;
}
