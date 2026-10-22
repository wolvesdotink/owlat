import rule from '../noTestInLoop.ts';
import { ruleTester } from '../../__tests__/ruleTester.ts';

const filename = 'cases.test.ts';
const imports = "import { describe, it, test } from 'vitest';\n";

ruleTester.run('owlat/no-test-in-loop', rule, {
	valid: [
		{
			name: 'it.each and describe.each',
			filename,
			code: `${imports}describe.each([1, 2])('suite %s', (n) => { it.each([n])('case %s', () => {}); });`,
		},
		{
			name: 'a loop inside a test body',
			filename,
			code: `${imports}it('checks every value', () => { for (const v of [1, 2]) { if (v < 0) throw new Error(); } });`,
		},
		{
			name: 'a loop inside a helper that the test calls',
			filename,
			code: `${imports}function check(values: number[]) { for (const v of values) expect(v).toBe(v); }\nit('works', () => check([1]));`,
		},
		{
			name: 'a test declared in a function that a loop calls is not a loop declaration',
			filename,
			code: `${imports}function declare(n: number) { it('case ' + n, () => {}); }\ndeclare(1);`,
		},
		{
			name: 'an unrelated function named test',
			filename,
			code: 'function test(name: string) { return name; }\nfor (const n of ["a"]) test(n);',
		},
		{
			name: 'a local binding that shadows the vitest import',
			filename,
			code: `${imports}function run(it: (s: string) => void) { for (const n of ["a"]) it(n); }`,
		},
		{
			name: 'a test helper module that happens to export `it`',
			filename,
			code: "import { it } from './helpers';\nfor (const n of [1]) it(String(n), () => {});",
		},
		{
			name: 'a local variable named `it` that is not an import',
			filename,
			code: "declare const api: { it: (s: string) => void };\nconst { it } = api;\nfor (const n of ['a']) it(n);",
		},
		{
			name: 'a global `it` with no import (vitest globals are off in this repo)',
			filename,
			code: "for (const n of ['a']) it(n, () => {});",
		},
		{
			name: 'a computed modifier the rule cannot read',
			filename,
			code: `${imports}const mode = 'skip' as const;\nfor (const n of ['a']) it[mode](n, () => {});`,
		},
		{
			name: 'a call whose callee is a call but not a vitest factory',
			filename,
			code: `${imports}const make = () => it;\nfor (const n of ['a']) make()(n, () => {});`,
		},
		{
			name: 'a factory call alone, which declares nothing until its result is called',
			filename,
			code: `${imports}for (const n of [1]) it.each([n]);`,
		},
		{
			name: 'a tagged template whose tag is not a vitest factory',
			filename,
			code: `${imports}declare const html: (s: TemplateStringsArray) => (t: string) => void;\nfor (const n of ['a']) html\`<p>\`(n);`,
		},
		{
			name: 'node:test, which is not vitest',
			filename,
			code: "import { test } from 'node:test';\nfor (const n of [1]) test(String(n), () => {});",
		},
	],
	invalid: [
		{
			name: 'it inside a for...of loop',
			filename,
			code: `${imports}for (const n of [1, 2]) { it(\`handles \${n}\`, () => {}); }`,
			errors: [{ message: /Do not declare it\(…\) inside a loop\. Use it\.each/ }],
		},
		{
			name: 'test inside a classic for loop nested in describe',
			filename,
			code: `${imports}describe('s', () => { for (let i = 0; i < 2; i++) test('t' + i, () => {}); });`,
			errors: 1,
		},
		{
			name: 'describe inside a for...in loop',
			filename,
			code: `${imports}for (const key in { a: 1 }) describe(key, () => {});`,
			errors: [{ message: /describe\.each/ }],
		},
		{
			name: 'a modifier chain inside a while loop',
			filename,
			code: `${imports}let i = 0;\nwhile (i++ < 2) it.skip.concurrent('t', () => {});`,
			errors: 1,
		},
		{
			name: 'a do...while loop',
			filename,
			code: `${imports}let i = 0;\ndo { it.only('t', () => {}); } while (i++ < 1);`,
			errors: 1,
		},
		{
			name: 'a curried .each declared inside a loop',
			filename,
			code: `${imports}for (const mode of ['a']) it.each([1])(mode + ' %s', () => {});`,
			errors: 1,
		},
		{
			name: 'a curried .skipIf inside a loop',
			filename,
			code: `${imports}for (const mode of ['a']) it.skipIf(mode === 'b')(mode, () => {});`,
			errors: 1,
		},
		{
			name: 'a non-null asserted test function',
			filename,
			code: `${imports}for (const n of ['a']) it!(n, () => {});`,
			errors: 1,
		},
		{
			name: 'a modifier read through a string key',
			filename,
			code: `${imports}for (const n of ['a']) it['only'](n, () => {});`,
			errors: 1,
		},
		{
			name: 'an extended test function called inside a loop',
			filename,
			code: `${imports}for (const n of ['a']) test.extend({})(n, () => {});`,
			errors: [{ message: /Do not declare test\(…\)/ }],
		},
		{
			name: 'a tagged-template it.each table inside a loop',
			filename,
			code: `${imports}for (const mode of ['a']) {\n\tit.each\`\n\t\ta | b\n\t\t\${1} | \${2}\n\t\`(mode + ' $a', () => {});\n}`,
			errors: [{ message: /Do not declare it\(…\) inside a loop/ }],
		},
		{
			name: 'a tagged-template describe.each table with a modifier inside a while loop',
			filename,
			code: `${imports}let i = 0;\nwhile (i++ < 2) describe.skip.each\`a\n\${1}\`('s', () => {});`,
			errors: [{ message: /Do not declare describe\(…\)/ }],
		},
		{
			name: 'a tagged-template test.for table inside a loop',
			filename,
			code: `${imports}for (const n of [1]) test.for\`a\n\${n}\`('t', () => {});`,
			errors: 1,
		},
		{
			name: 'a factory chained onto another factory',
			filename,
			code: `${imports}for (const n of [1]) it.skipIf(n > 1).each([n])('t %s', () => {});`,
			errors: 1,
		},
		{
			name: 'a modifier on an extended test function',
			filename,
			code: `${imports}for (const n of ['a']) test.extend({}).only(n, () => {});`,
			errors: [{ message: /Do not declare test\(…\)/ }],
		},
		{
			name: 'an aliased vitest import',
			filename,
			code: "import { it as vit } from 'vitest';\nfor (const n of [1]) vit(String(n), () => {});",
			errors: [{ message: /Do not declare it\(…\)/ }],
		},
		{
			name: 'a namespace vitest import',
			filename,
			code: "import * as vitest from 'vitest';\nfor (const n of [1]) vitest.test(String(n), () => {});",
			errors: [{ message: /Do not declare test\(…\)/ }],
		},
		{
			name: 'each nested declaration in a nested loop',
			filename,
			code: `${imports}for (const a of [1]) { describe(String(a), () => { for (const b of [2]) it(String(b), () => {}); }); }`,
			errors: 2,
		},
	],
});
