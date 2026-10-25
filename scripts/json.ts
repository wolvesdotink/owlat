/**
 * Decoders for the JSON the repository scripts read: package manifests, tool
 * reports, GitHub API answers, CI artifacts. `JSON.parse` returns `any`, and a
 * cast of it checks nothing, so a script read through a cast acts on whatever
 * shape it was handed. These parse to `unknown` and check every field a caller
 * declares before the value is typed.
 *
 * Decoded objects keep the fields the caller did not declare: a script that
 * passes a value on (the CI selection writes the image entries back out) must
 * not drop what it does not read. Errors name the path that failed and what was
 * expected there, never the value, so a decoded secret or token cannot end up
 * in a log.
 *
 * Dependency-free on purpose: the scripts run with bun from the repository root
 * and do not depend on the workspace packages.
 */

export class JsonShapeError extends Error {
	override name = 'JsonShapeError';
}

/** Checks `value` (found at `path`) and returns it typed, or throws a JsonShapeError. */
export type Decoder<T> = (value: unknown, path: string) => T;

/** A decoder whose field may be absent; `object` leaves an absent field out. */
interface OptionalDecoder<T> extends Decoder<T | undefined> {
	readonly optional: true;
}

type Decoded<D> = D extends Decoder<infer T> ? T : never;

type Fields = Record<string, Decoder<unknown>>;

type ObjectOf<F extends Fields> = {
	[K in keyof F as F[K] extends OptionalDecoder<unknown> ? never : K]: Decoded<F[K]>;
} & {
	[K in keyof F as F[K] extends OptionalDecoder<unknown> ? K : never]?: Exclude<
		Decoded<F[K]>,
		undefined
	>;
};

const fail = (path: string, expected: string): never => {
	throw new JsonShapeError(`${path} must be ${expected}`);
};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * `text` parsed to `unknown`; malformed text is a JsonShapeError naming `label`.
 * The parser's own message is dropped: it quotes the text around the error.
 */
export function parseJson(text: string, label: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		throw new JsonShapeError(`${label} is not valid JSON`);
	}
}

/** `text` parsed and checked by `decode`; `label` names the source in errors. */
export function decodeJson<T>(text: string, decode: Decoder<T>, label: string): T {
	return decode(parseJson(text, label), label);
}

/** Any value, left for the caller to check (an envelope's payload). */
export const unchecked: Decoder<unknown> = (value) => value;

export const string: Decoder<string> = (value, path) =>
	typeof value === 'string' ? value : fail(path, 'a string');

/** A finite number. */
export const number: Decoder<number> = (value, path) =>
	typeof value === 'number' && Number.isFinite(value) ? value : fail(path, 'a finite number');

export const integer: Decoder<number> = (value, path) =>
	Number.isSafeInteger(value) ? (value as number) : fail(path, 'an integer');

export const boolean: Decoder<boolean> = (value, path) =>
	typeof value === 'boolean' ? value : fail(path, 'a boolean');

/** Exactly one of `choices`. */
export const literal =
	<const T extends string | number | boolean>(...choices: T[]): Decoder<T> =>
	(value, path) =>
		choices.includes(value as T) ? (value as T) : fail(path, `one of ${choices.join(', ')}`);

export const nullable =
	<T>(decode: Decoder<T>): Decoder<T | null> =>
	(value, path) =>
		value === null ? null : decode(value, path);

/** A field that may be absent (or `undefined`); present, it must pass `decode`. */
export const optional = <T>(decode: Decoder<T>): OptionalDecoder<T> =>
	Object.assign(
		(value: unknown, path: string) => (value === undefined ? undefined : decode(value, path)),
		{ optional: true as const }
	);

export const arrayOf =
	<T>(decode: Decoder<T>): Decoder<T[]> =>
	(value, path) =>
		Array.isArray(value)
			? value.map((item, index) => decode(item, `${path}[${index}]`))
			: fail(path, 'an array');

/** An object whose every value passes `decode`, under any key. */
export const recordOf =
	<T>(decode: Decoder<T>): Decoder<Record<string, T>> =>
	(value, path) => {
		if (!isRecord(value)) return fail(path, 'an object');
		// fromEntries defines each key as data, so a `__proto__` key stays a key.
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [key, decode(item, `${path}.${key}`)])
		);
	};

/** Any JSON object, its members unchecked (for a caller that inspects them itself). */
export const record: Decoder<Record<string, unknown>> = (value, path) =>
	isRecord(value) ? value : fail(path, 'an object');

/**
 * An object with the declared fields checked. Undeclared fields are kept as
 * they were; an optional field that is absent stays absent.
 */
export const object =
	<F extends Fields>(fields: F): Decoder<ObjectOf<F>> =>
	(value, path) => {
		if (!isRecord(value)) return fail(path, 'an object');
		const out: Record<string, unknown> = { ...value };
		for (const [key, decode] of Object.entries(fields)) {
			const decoded = decode(value[key], `${path}.${key}`);
			if (decoded !== undefined) out[key] = decoded;
		}
		return out as ObjectOf<F>;
	};

/** The first of `decoders` that accepts the value, for a field with alternative shapes. */
export const oneOf =
	<T>(expected: string, ...decoders: Decoder<T>[]): Decoder<T> =>
	(value, path) => {
		for (const decode of decoders) {
			try {
				return decode(value, path);
			} catch (error) {
				if (!(error instanceof JsonShapeError)) throw error;
			}
		}
		return fail(path, expected);
	};
