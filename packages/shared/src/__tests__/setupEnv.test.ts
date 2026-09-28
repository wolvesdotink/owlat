import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readEnvFile, writeEnvFile, type EnvMap } from '../setupEnv';

describe('writeEnvFile', () => {
	let dir: string;
	let path: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'owlat-env-'));
		path = join(dir, '.env');
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it('rejects a value containing a newline instead of emitting a physical multi-line value', async () => {
		// A newline pushed through an allowlisted key (e.g. DEFAULT_FROM_NAME) would
		// otherwise inject an arbitrary extra `.env` line the operator never set.
		await expect(
			writeEnvFile(path, { DEFAULT_FROM_NAME: 'Acme\nINSTANCE_SECRET=attacker-owned' })
		).rejects.toThrow(/newline, carriage return, or NUL/);
	});

	it.each([
		['carriage return', 'Acme\rINSTANCE_SECRET=x'],
		['NUL', 'Acme\0x'],
	])('rejects a value containing a %s', async (_label, value) => {
		await expect(writeEnvFile(path, { DEFAULT_FROM_NAME: value })).rejects.toThrow();
	});

	it('never emits a physical multi-line value: every written line round-trips to one key', async () => {
		await writeEnvFile(path, {
			EMAIL_PROVIDER: 'resend',
			DEFAULT_FROM_NAME: 'Acme Mailer',
			RESEND_API_KEY: 're_test_123',
		});
		const raw = await readFile(path, 'utf-8');
		// No emitted value line may itself contain a bare newline in its content: the
		// only newlines in the file are the line separators the writer controls.
		const valueLines = raw.split('\n').filter((l) => l && !l.startsWith('#'));
		expect(valueLines).toHaveLength(3);
		// And the file reconstructs exactly the map it was handed — no injected keys.
		const roundTripped = await readEnvFile(path);
		expect(roundTripped).toMatchObject({
			EMAIL_PROVIDER: 'resend',
			DEFAULT_FROM_NAME: 'Acme Mailer',
			RESEND_API_KEY: 're_test_123',
		});
		expect(roundTripped).not.toHaveProperty('INSTANCE_SECRET');
	});

	it('escapes `\\`, `"` and `$` inside double quotes and leaves plain values bare', async () => {
		await writeEnvFile(path, {
			PLAIN: 're_test_123',
			DASH: '-dash',
			SPACE: 'Acme Mailer',
			HASH: 'a#b',
			SPECIAL: 'a\\b"c$d',
		});
		const lines = (await readFile(path, 'utf-8')).split('\n').filter((l) => /^[A-Z]/.test(l));
		expect(lines).toEqual([
			'PLAIN=re_test_123',
			'DASH=-dash',
			'SPACE="Acme Mailer"',
			'HASH="a#b"',
			'SPECIAL="a\\\\b\\"c\\$d"',
		]);
	});
});

// Every expectation below was checked against `docker compose config` (compose
// v5.5.1) reading the same text as an env_file, with `$$` in its output read
// back as `$`.
describe('readEnvFile follows docker compose', () => {
	let dir: string;
	let files = 0;

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), 'owlat-env-parse-'));
	});

	afterAll(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	async function parse(text: string): Promise<EnvMap> {
		const path = join(dir, `${files++}.env`);
		await writeFile(path, text);
		return readEnvFile(path);
	}

	it('drops an inline ` #` comment from an unquoted value (the push-env / container mismatch)', async () => {
		expect(await parse('LLM_API_KEY=sk-x # rotated\n')).toEqual({ LLM_API_KEY: 'sk-x' });
	});

	it.each([
		['a `#` with no space before it is part of the value', 'A=sk-x#frag', 'sk-x#frag'],
		['a tab before `#` is not a comment', 'A=a\t#tab', 'a\t#tab'],
		['a value that is only `# ...` stays', 'A=  # c', '# c'],
		['surrounding whitespace is trimmed', 'A=  spaced   value   ', 'spaced   value'],
		['an empty value is empty', 'A=', ''],
		['a backslash in an unquoted value is literal', 'A=val\\ue', 'val\\ue'],
		['`$` references are kept as written', 'A=$HOME ${X}', '$HOME ${X}'],
		['`$$` is a literal `$`', 'A=pa$$word', 'pa$word'],
		['a `$` that starts no reference is literal', 'A=a$ b$$$', 'a$ b$$'],
	])('unquoted: %s', async (_label, line, value) => {
		expect(await parse(`${line}\n`)).toEqual({ A: value });
	});

	it.each([
		[
			'is literal apart from an escaped quote',
			"A='single $HOME \\n \\' x'",
			"single $HOME \\n ' x",
		],
		['keeps a doubled backslash', "A='a\\\\b'", 'a\\\\b'],
		['keeps ` #` inside the quotes', "A='x # y'", 'x # y'],
		['keeps `$$` as written', "A='pa$$word'", 'pa$$word'],
	])('single-quoted: %s', async (_label, line, value) => {
		expect(await parse(`${line}\n`)).toEqual({ A: value });
	});

	it.each([
		[
			'expands escapes and keeps unknown ones',
			'A="dq \\n \\t \\\\ \\" \\$HOME \\q \\0123 \\012 end"',
			'dq \n \t \\ " $HOME \\q S \\12 end',
		],
		['expands the control-character escapes', 'A="\\a\\b\\f\\v\\c"', '\x07\b\f\v\\c'],
		['reads an escaped backslash then an escaped quote', 'A="a\\\\\\"b"', 'a\\"b'],
		['reads `$$` as a literal `$`', 'A="pa$$word"', 'pa$word'],
		['reads `\\$$` as `$$`', 'A="\\$$"', '$$'],
		['ignores a comment after the closing quote', 'A="quoted" # trailing', 'quoted'],
		['skips a bare word after the closing quote', 'A="x"y', 'x'],
		['spans lines', 'A="multi\nline"', 'multi\nline'],
	])('double-quoted: %s', async (_label, text, value) => {
		expect(await parse(`${text}\n`)).toEqual({ A: value });
	});

	it('strips an `export ` prefix, accepts `KEY: value` and spaces around `=`', async () => {
		expect(await parse('export C=exported\nI: yamlstyle\nQ = spacedkey\n')).toEqual({
			C: 'exported',
			I: 'yamlstyle',
			Q: 'spacedkey',
		});
	});

	it('accepts CRLF line endings and a UTF-8 byte-order mark', async () => {
		const bom = String.fromCharCode(0xfeff);
		expect(await parse(`${bom}S=crlf\r\nT="crlf2"\r\nU=x # c\r\n`)).toEqual({
			S: 'crlf',
			T: 'crlf2',
			U: 'x',
		});
	});

	it('skips comments, blank lines, lines without `=` and invalid keys; the last duplicate wins', async () => {
		expect(await parse('# comment\n\n   # indented comment\nBARE\nBAD KEY=x\nA=1\nA=2\n')).toEqual({
			A: '2',
		});
	});

	it('reads a statement that follows the closing quote on the same line', async () => {
		expect(await parse('A="x" B=y\nC="multi\nline" D=\'z\' # c\n')).toEqual({
			A: 'x',
			B: 'y',
			C: 'multi\nline',
			D: 'z',
		});
	});

	it('takes an unterminated quoted value literally to the end of its line instead of failing', async () => {
		expect(await parse('A="open\nB=2\n')).toEqual({ A: '"open', B: '2' });
	});

	it("does not let an unterminated quote swallow a later line's key", async () => {
		// The next `"` is B's opening quote, and what follows it (`x"`) is not
		// something compose could read on from, so A's quote is unterminated.
		expect(await parse('A="abc\nB="x"\nC=3\n')).toEqual({ A: '"abc', B: 'x', C: '3' });
	});

	it('reads a hand-edited file the way compose does', async () => {
		expect(
			await parse(
				'export LLM_API_KEY=sk-x # rotated\r\nSMTP_RELAY_PASSWORD="p\\"w\\\\d"\r\nNAME=\'Acme $Co\'\r\n'
			)
		).toEqual({
			LLM_API_KEY: 'sk-x',
			SMTP_RELAY_PASSWORD: 'p"w\\d',
			NAME: 'Acme $Co',
		});
	});
});

describe('readEnvFile / writeEnvFile round trip', () => {
	let dir: string;

	async function valueLines(path: string): Promise<string[]> {
		return (await readFile(path, 'utf-8')).split('\n').filter((l) => l && !l.startsWith('#'));
	}

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'owlat-env-'));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it('writes values that read back unchanged, including ones compose would otherwise rewrite', async () => {
		const path = join(dir, '.env');
		const values = {
			DOLLAR: 'pa$$word',
			REFS: '$HOME ${X} $(id)',
			BACKSLASH: 'a\\b',
			LITERAL_ESCAPE: 'lit\\n',
			TRAILING_BACKSLASH: 'trailing\\',
			QUOTE: 'q"uote',
			APOSTROPHE: "it's",
			BACKTICK: 'back`tick',
			HASH: 'x # y',
			LEADING_HASH: '#lead',
			LEADING_DASH: '-dash',
			PADDED: ' space ',
			EQUALS: 'a=b',
			TAB: 'tab\there',
			MIXED: '\\"$\\$',
			EMPTY: '',
			UNICODE: 'ünïcödé',
		};
		await writeEnvFile(path, values);
		expect(await readEnvFile(path)).toEqual(values);
	});

	it('keeps the text of values the rewrite did not change, so compose reads them as before', async () => {
		// `$$` and `${VAR}` are compose's own syntax: compose gives the
		// containers `pa$word` and the resolved reference. Re-encoding them
		// would escape the `$` and change both; an old writer's literal `\n`
		// would decode to a newline the writer refuses.
		const path = join(dir, '.env');
		const original = [
			'G=pa$$word',
			'V=https://${HOST_X:-dflt}/x',
			"S='single $X'",
			'M="line1\\nline2"',
			'Q="multi',
			'line"',
			'export E=exported # comment',
		];
		await writeFile(path, `${original.join('\n')}\n`);
		const before = await readEnvFile(path);
		expect(before).toMatchObject({
			G: 'pa$word',
			V: 'https://${HOST_X:-dflt}/x',
			M: 'line1\nline2',
		});

		await writeEnvFile(path, { ...before, OWLAT_VERSION: '1.2.3' });

		expect(await valueLines(path)).toEqual([
			'G=pa$$word',
			'V=https://${HOST_X:-dflt}/x',
			"S='single $X'",
			'M="line1\\nline2"',
			'Q="multi',
			'line"',
			'E=exported',
			'OWLAT_VERSION=1.2.3',
		]);
		expect(await readEnvFile(path)).toEqual({ ...before, OWLAT_VERSION: '1.2.3' });
	});

	it('re-encodes a value the caller changed, escaping its `$`', async () => {
		const path = join(dir, '.env');
		await writeFile(path, 'A=${X}\nB=pa$$word\n');
		await writeEnvFile(path, { A: '${Y}', B: 'pa$word!' });
		expect(await valueLines(path)).toEqual(['A="\\${Y}"', 'B="pa\\$word!"']);
		expect(await readEnvFile(path)).toEqual({ A: '${Y}', B: 'pa$word!' });
	});
});
