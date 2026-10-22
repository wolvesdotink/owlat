/**
 * `owlat/require-suppression-reason` must recognize a TypeScript directive in
 * every comment form the compiler obeys, and only there. Each fixture puts one
 * reason-less directive form above a type error. The real TypeScript compiler
 * decides which forms suppress the error (the directive was honoured), and the
 * real oxlint with the root config reports the rule on some set of fixtures;
 * the two sets have to be equal.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PARALLEL_GATE_TIMEOUT_MS } from '../../../../vitest.timeouts';
import { lintFixtures } from './runOxlint.ts';

const RULE = 'owlat(require-suppression-reason)';

/** Fixture name -> the comment placed directly above the type error. */
const HEADERS: Record<string, string> = {
	'expect-error-line': '// @ts-expect-error',
	'expect-error-triple-slash': '/// @ts-expect-error',
	'expect-error-triple-slash-no-space': '///@ts-expect-error',
	'expect-error-four-slashes': '//// @ts-expect-error',
	'expect-error-glued-letters': '// @ts-expect-errors',
	'expect-error-behind-star': '// * @ts-expect-error',
	'expect-error-prose': '// keep the @ts-expect-error below',
	'expect-error-block': '/* @ts-expect-error */',
	'expect-error-jsdoc': '/** @ts-expect-error **/',
	'expect-error-block-last-line': '/*\n *\n * @ts-expect-error */',
	'expect-error-block-first-line': '/* @ts-expect-error\n */',
	'ignore-line': '// @ts-ignore',
	'ignore-triple-slash': '/// @ts-ignore',
	'ignore-slash-in-block': '/*/ @ts-ignore */',
	'nocheck-line': '// @ts-nocheck',
	'nocheck-triple-slash': '/// @ts-nocheck',
	'nocheck-upper-case': '// @TS-NOCHECK',
	'nocheck-colon': '// @ts-nocheck:',
	'nocheck-glued-letters': '// @ts-nocheckout',
	'nocheck-block': '/* @ts-nocheck */',
};
const TYPESCRIPT_OBEYS = [
	'expect-error-block',
	'expect-error-block-last-line',
	'expect-error-glued-letters',
	'expect-error-jsdoc',
	'expect-error-line',
	'expect-error-triple-slash',
	'expect-error-triple-slash-no-space',
	'ignore-line',
	'ignore-slash-in-block',
	'ignore-triple-slash',
	'nocheck-colon',
	'nocheck-line',
	'nocheck-triple-slash',
	'nocheck-upper-case',
];

let fixtureDirectory: string;

beforeAll(() => {
	fixtureDirectory = mkdtempSync(join(tmpdir(), 'owlat-ts-directive-parity-'));
	for (const [name, header] of Object.entries(HEADERS)) {
		writeFileSync(
			join(fixtureDirectory, `${name}.ts`),
			`${header}\nexport const value: number = 'text';\n`
		);
	}
});

afterAll(() => {
	rmSync(fixtureDirectory, { recursive: true, force: true });
});

/** Fixture names whose type error TypeScript suppressed, i.e. it obeyed the directive. */
function filesTypeScriptSuppressed(): string[] {
	const files = Object.keys(HEADERS).map((name) => join(fixtureDirectory, `${name}.ts`));
	const program = ts.createProgram(files, {
		noEmit: true,
		strict: true,
		skipLibCheck: true,
		types: [],
	});
	return files
		.filter((file) => program.getSemanticDiagnostics(program.getSourceFile(file)).length === 0)
		.map((file) => basename(file, '.ts'))
		.sort();
}

describe('require-suppression-reason agrees with TypeScript', () => {
	it(
		'reports exactly the reason-less directive forms TypeScript obeys',
		() => {
			const suppressed = filesTypeScriptSuppressed();
			expect(suppressed).toEqual(TYPESCRIPT_OBEYS);
			const reported = [...lintFixtures(fixtureDirectory)]
				.filter(([, diagnostics]) => diagnostics.some(({ code }) => code === RULE))
				.map(([file]) => basename(file, '.ts'))
				.sort();
			expect(reported).toEqual(suppressed);
		},
		PARALLEL_GATE_TIMEOUT_MS
	);
});
