import rule from '../noTestTimeoutOrUnreasonedSkip.ts';
import { ruleTester } from '../../__tests__/ruleTester.ts';

const filename = 'cases.test.ts';
const imports =
	"import { afterAll, beforeAll, beforeEach, describe, it, test, vi } from 'vitest';\n";
const shared = "import { PARALLEL_GATE_TIMEOUT_MS } from '../../vitest.timeouts';\n";
const TIMEOUT = /shared budget from vitest\.timeouts\.ts/;
const RETRY = /Tests are not retried/;
const SKIP = /quarantine: #<issue> <why>/;

ruleTester.run('owlat/no-test-timeout-or-unreasoned-skip', rule, {
	valid: [
		{
			name: 'a test with no timeout',
			filename,
			code: `${imports}it('works', () => {});\ndescribe('suite', () => { it('works', async () => {}); });`,
		},
		{
			name: 'a positional timeout from the shared module',
			filename,
			code: `${imports}${shared}it('slow', async () => {}, PARALLEL_GATE_TIMEOUT_MS);`,
		},
		{
			name: 'the shared module imported with its extension',
			filename,
			code: `${imports}import { PARALLEL_GATE_TIMEOUT_MS } from '../../vitest.timeouts.ts';\nit('slow', async () => {}, PARALLEL_GATE_TIMEOUT_MS);`,
		},
		{
			name: 'an options timeout from the shared module, on a test and a suite',
			filename,
			code: `${imports}${shared}describe('s', { timeout: PARALLEL_GATE_TIMEOUT_MS }, () => { it('t', { timeout: PARALLEL_GATE_TIMEOUT_MS }, () => {}); });`,
		},
		{
			name: 'a namespace import of the shared module',
			filename,
			code: `${imports}import * as budgets from '../vitest.timeouts';\nit('slow', () => {}, budgets.PARALLEL_GATE_TIMEOUT_MS);`,
		},
		{
			name: 'a const alias of a shared constant',
			filename,
			code: `${imports}${shared}const SLOW = PARALLEL_GATE_TIMEOUT_MS;\nconst SLOWER = SLOW;\nbeforeAll(() => {}, SLOWER);`,
		},
		{
			name: 'a hook timeout from the shared module, through an aliased import',
			filename,
			code: `import { afterAll as after } from 'vitest';\n${shared}after(() => {}, PARALLEL_GATE_TIMEOUT_MS);`,
		},
		{
			name: 'skipIf and runIf on an environment condition',
			filename,
			code: `${imports}describe.skipIf(process.platform === 'win32')('posix', () => {});\nit.runIf(process.env.REDIS_URL)('needs redis', () => {});\ntest.skipIf(!hasDocker).concurrent('docker', () => {});`,
		},
		{
			name: 'a skip option computed from the environment',
			filename,
			code: `${imports}it('posix only', { skip: process.platform === 'win32' }, () => {});`,
		},
		{
			name: 'a quarantined skip and todo',
			filename,
			code: `${imports}// quarantine: #1234 the relay drops the second hello under load\nit.skip('relays twice', () => {});\ndescribe('s', () => {\n\t// The whole suite waits on a fix upstream.\n\t// quarantine: #99 needs the new parser\n\tit.todo('parses folded headers');\n});`,
		},
		{
			name: 'a quarantined skip option and literal skipIf',
			filename,
			code: `${imports}/* quarantine: #7 the fixture moved */\nit('reads the fixture', { skip: true }, () => {});\n// quarantine: #8 off until the migration lands\nit.skipIf(true)('migrates', () => {});`,
		},
		{
			name: 'vi.waitFor and other non-test timeouts',
			filename,
			code: `${imports}it('waits', async () => { await vi.waitFor(() => {}, { timeout: 10_000 }); spawnSync('x', [], { timeout: 120_000 }); });`,
		},
		{
			name: 'a test helper module that happens to export it',
			filename,
			code: "import { expect } from 'vitest';\nimport { it } from './helpers';\nit('x', () => {}, 30_000);\nit.skip('y', () => {});",
		},
		{
			name: 'a local function named test',
			filename,
			code: "import { expect } from 'vitest';\nfunction test(name: string, fn: () => void, timeout: number) { return [name, fn, timeout]; }\ntest('x', () => {}, 30_000);",
		},
		{
			name: 'node:test, which is not vitest',
			filename,
			code: "import { expect } from 'vitest';\nimport { test } from 'node:test';\ntest('x', { timeout: 30_000, skip: true }, () => {});",
		},
		{
			name: 'options first with a named test function',
			filename,
			code: `${imports}const run = () => {};\nit('x', { concurrent: true }, run);`,
		},
		{
			name: 'options kept in a const and a named test function, declared or const',
			filename,
			code: `${imports}${shared}const opts = { concurrent: true, timeout: PARALLEL_GATE_TIMEOUT_MS };\nfunction run() {}\nconst runArrow = () => {};\nit('x', opts, run);\nit('y', opts, runArrow);`,
		},
		{
			name: 'a named test function followed by a shared budget',
			filename,
			code: `${imports}${shared}function run() {}\nit('x', run, PARALLEL_GATE_TIMEOUT_MS);`,
		},
		{
			name: 'a quarantine comment continued on the lines below it',
			filename,
			code: `${imports}// quarantine: #5 the relay drops the second hello\n// under load, until the queue rewrite lands\nit.skip('relays twice', () => {});`,
		},
		{
			name: 'an import-free vitest config without retry',
			filename: 'vitest.config.ts',
			code: 'export default { test: { testTimeout: 10_000 } };',
		},
		{
			name: 'retry outside a vitest config is a different retry',
			filename: 'client.ts',
			code: 'export const client = { retry: 3 };',
		},
		{
			name: 'a vitest config without retry',
			filename: 'vitest.config.ts',
			code: "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { testTimeout: 10_000 } });",
		},
	],
	invalid: [
		{
			name: 'a positional numeric timeout',
			filename,
			code: `${imports}it('slow', async () => {}, 30_000);`,
			errors: [{ message: TIMEOUT }],
		},
		{
			name: 'a local constant timeout',
			filename,
			code: `${imports}const SLOW = 15_000;\ntest('slow', () => {}, SLOW);`,
			errors: [{ message: TIMEOUT }],
		},
		{
			name: 'arithmetic on a shared constant is a new number',
			filename,
			code: `${imports}${shared}it('slow', () => {}, PARALLEL_GATE_TIMEOUT_MS * 2);`,
			errors: [{ message: TIMEOUT }],
		},
		{
			name: 'a let alias is not a fixed budget',
			filename,
			code: `${imports}${shared}let slow = PARALLEL_GATE_TIMEOUT_MS;\nit('slow', () => {}, slow);`,
			errors: [{ message: TIMEOUT }],
		},
		{
			name: 'an options timeout on a test and on a suite',
			filename,
			code: `${imports}describe('s', { timeout: 60_000 }, () => { it('t', { timeout: 5000 }, () => {}); });`,
			errors: [{ message: TIMEOUT }, { message: TIMEOUT }],
		},
		{
			name: 'an options object as the third argument',
			filename,
			code: `${imports}it('t', () => {}, { timeout: 5000 });`,
			errors: [{ message: TIMEOUT }],
		},
		{
			name: 'timeouts through modifiers, .each and the namespace import',
			filename,
			code: `import * as vitest from 'vitest';\nvitest.it.concurrent('a', () => {}, 1000);\nvitest.describe.each([1])('b %s', () => {}, 2000);\nvitest.test.for([1])('c %s', { timeout: 3000 }, () => {});`,
			errors: [{ message: TIMEOUT }, { message: TIMEOUT }, { message: TIMEOUT }],
		},
		{
			name: 'a hook timeout',
			filename,
			code: `${imports}beforeAll(async () => {}, 120_000);\nbeforeEach(() => {}, 20000);\nafterAll(() => {}, 1000);`,
			errors: [{ message: TIMEOUT }, { message: TIMEOUT }, { message: TIMEOUT }],
		},
		{
			name: 'vi.setConfig timeouts and retry',
			filename,
			code: `${imports}vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000, retry: 2 });`,
			errors: [{ message: TIMEOUT }, { message: TIMEOUT }, { message: RETRY }],
		},
		{
			name: 'a retry option of any value',
			filename,
			code: `${imports}it('flaky', { retry: 3 }, () => {});\ndescribe('s', { retry: 0 }, () => {});`,
			errors: [{ message: RETRY }, { message: RETRY }],
		},
		{
			name: 'retry in a vitest config, nested in a project',
			filename: 'apps/api/vitest.config.ts',
			code: "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { retry: 1, projects: [{ test: { 'retry': 2 } }] } });",
			errors: [{ message: RETRY }, { message: RETRY }],
		},
		{
			name: 'retry in an import-free vitest config',
			filename: 'vitest.shared.ts',
			code: 'export default { test: { retry: 1 } };',
			errors: [{ message: RETRY }],
		},
		{
			name: 'options kept in a const, followed by an inline or named test function',
			filename,
			code: `${imports}const opts = { retry: 1 };\nfunction run() {}\nit('a', opts, () => {});\nit('b', opts, run);`,
			errors: [{ message: RETRY }, { message: RETRY }],
		},
		{
			name: 'options through an alias chain and a spread',
			filename,
			code: `${imports}const base = { skip: true };\nconst alias = base;\nit('a', alias, () => {});\nit('b', { ...{ timeout: 5000 }, concurrent: true }, () => {});\nconst shared = { retry: 2 };\ndescribe('c', { ...shared }, () => {});`,
			errors: [{ message: SKIP }, { message: TIMEOUT }, { message: RETRY }],
		},
		{
			name: 'old-style options in a const after a named test function',
			filename,
			code: `${imports}const run = () => {};\nconst opts = { timeout: 5000 };\nit('a', run, opts);`,
			errors: [{ message: TIMEOUT }],
		},
		{
			name: 'vi.setConfig options kept in a const',
			filename,
			code: `${imports}const config = { retry: 1, testTimeout: 1000 };\nvi.setConfig(config);`,
			errors: [{ message: RETRY }, { message: TIMEOUT }],
		},
		{
			name: 'a quarantine comment cut off from the skip by a blank line or another comment block',
			filename,
			code: `${imports}// quarantine: #1 the relay drops the second hello\n\nit.skip('a', () => {});\n// quarantine: #2 the fixture moved\n\n// an unrelated note\n\nit.skip('b', () => {});\n// quarantine: #3 the parser chokes\n\n// an unrelated note right above\nit.skip('c', () => {});`,
			errors: [{ message: SKIP }, { message: SKIP }, { message: SKIP }],
		},
		{
			name: 'a skip and a todo with no comment',
			filename,
			code: `${imports}it.skip('a', () => {});\ndescribe.todo('b');\ntest.todo('c');`,
			errors: [{ message: SKIP }, { message: SKIP }, { message: SKIP }],
		},
		{
			name: 'a comment that names no issue or gives no reason',
			filename,
			code: `${imports}// flaky on CI\nit.skip('a', () => {});\n// quarantine: #12\nit.skip('b', () => {});\n// quarantine: 12 no hash\nit.skip('c', () => {});`,
			errors: [{ message: SKIP }, { message: SKIP }, { message: SKIP }],
		},
		{
			name: 'a quarantine comment above a different statement',
			filename,
			code: `${imports}// quarantine: #1 the first one\nit.skip('a', () => {});\nit.skip('b', () => {});`,
			errors: [{ message: SKIP }],
		},
		{
			name: 'skip through modifier chains, .each and a string key',
			filename,
			code: `${imports}it.concurrent.skip('a', () => {});\nit.skip.each([1])('b %s', () => {});\nit['skip']('c', () => {});`,
			errors: [{ message: SKIP }, { message: SKIP }, { message: SKIP }],
		},
		{
			name: 'a literal skip or todo option',
			filename,
			code: `${imports}it('a', { skip: true }, () => {});\nit('b', { todo: true }, () => {});`,
			errors: [{ message: SKIP }, { message: SKIP }],
		},
		{
			name: 'skipIf and runIf on a literal',
			filename,
			code: `${imports}it.skipIf(true)('a', () => {});\ndescribe.runIf(false)('b', () => {});`,
			errors: [{ message: SKIP }, { message: SKIP }],
		},
		{
			name: 'a skipped test that also has a local timeout reports both',
			filename,
			code: `${imports}it.skip('a', () => {}, 5000);`,
			errors: [{ message: SKIP }, { message: TIMEOUT }],
		},
	],
});
