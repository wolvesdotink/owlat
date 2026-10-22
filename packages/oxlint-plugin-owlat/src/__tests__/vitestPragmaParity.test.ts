/**
 * `owlat/no-test-environment-pragma` must flag exactly the files whose
 * environment vitest itself would switch. Each fixture below is run by the real
 * vitest under a probe environment (a local `vitest-environment-owlat-probe`
 * package that marks the global scope) and linted by the real oxlint with the
 * root config. A fixture's test fails when vitest picked the probe environment
 * up from its text; that set has to equal the set the rule reports.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PARALLEL_GATE_TIMEOUT_MS } from '../../../../vitest.timeouts';
import { lintFixtures } from './runOxlint.ts';

const VITEST_BIN = join(
	dirname(createRequire(import.meta.url).resolve('vitest/package.json')),
	'vitest.mjs'
);
// Vitest scans this file's own text for the pragma, so the fixtures build it.
const TAG = '@vitest-environment';
const JEST_TAG = '@jest-environment';
const PROBE = 'owlat-probe';
const RULE = 'owlat(no-test-environment-pragma)';

/** Fixture name -> the line placed above the probe test. */
const HEADERS: Record<string, string> = {
	'line-comment': `// ${TAG} ${PROBE}`,
	docblock: `/**\n * ${TAG} ${PROBE}\n */`,
	'prose-comment': `// This test uses ${TAG} ${PROBE} on purpose.`,
	'string-literal': `const note = '${TAG} ${PROBE}';`,
	'jest-tag': `// ${JEST_TAG} ${PROBE}`,
	'next-line-word': `const note = \`${TAG}\n${PROBE}\`;`,
	'quoted-tag': `// Never add a \`${TAG}\` pragma here.`,
	'options-pragma': `// ${TAG}-options {"probe": true}`,
	'no-pragma': '// An ordinary comment.',
};
const VITEST_SWITCHES = [
	'docblock',
	'jest-tag',
	'line-comment',
	'next-line-word',
	'prose-comment',
	'string-literal',
];

const PROBE_TEST =
	"it('runs in the configured environment', () => { if ('owlatProbe' in globalThis) throw new Error('probe environment'); });";

let fixtureDirectory: string;

beforeAll(() => {
	fixtureDirectory = mkdtempSync(join(tmpdir(), 'owlat-pragma-parity-'));
	// Globals keep the fixtures free of imports, so nothing has to resolve
	// `vitest` from the temporary directory.
	writeFileSync(
		join(fixtureDirectory, 'vitest.config.mjs'),
		"export default { test: { globals: true, include: ['*.test.js'] } };\n"
	);
	for (const [name, header] of Object.entries(HEADERS)) {
		writeFileSync(join(fixtureDirectory, `${name}.test.js`), `${header}\n${PROBE_TEST}\n`);
	}
	const environment = join(fixtureDirectory, 'node_modules', `vitest-environment-${PROBE}`);
	mkdirSync(environment, { recursive: true });
	writeFileSync(
		join(environment, 'package.json'),
		JSON.stringify({ name: `vitest-environment-${PROBE}`, type: 'module', main: 'index.js' })
	);
	writeFileSync(
		join(environment, 'index.js'),
		`export default { name: '${PROBE}', viteEnvironment: 'ssr', setup() { globalThis.owlatProbe = true; return { teardown() { delete globalThis.owlatProbe; } }; } };\n`
	);
});

afterAll(() => {
	rmSync(fixtureDirectory, { recursive: true, force: true });
});

/** Fixture names whose probe test failed, i.e. vitest ran them in the probe environment. */
function filesVitestSwitched(): string[] {
	const report = join(fixtureDirectory, 'report.json');
	// The child must not think it is a worker of this vitest run.
	const env = Object.fromEntries(
		Object.entries(process.env).filter(([key]) => !key.startsWith('VITEST'))
	);
	const run = spawnSync(
		process.execPath,
		[VITEST_BIN, 'run', '--root', fixtureDirectory, '--reporter=json', `--outputFile=${report}`],
		{ cwd: fixtureDirectory, encoding: 'utf8', env }
	);
	if (run.status !== 0 && run.status !== 1) {
		throw new Error(`vitest exited ${String(run.status)}: ${run.stderr}`);
	}
	const { testResults } = JSON.parse(readFileSync(report, 'utf8')) as {
		testResults: { name: string; status: string }[];
	};
	expect(testResults).toHaveLength(Object.keys(HEADERS).length);
	return testResults
		.filter(({ status }) => status !== 'passed')
		.map(({ name }) => basename(name, '.test.js'))
		.sort();
}

describe('no-test-environment-pragma agrees with vitest', () => {
	it(
		'reports exactly the files whose environment vitest switches',
		() => {
			const switched = filesVitestSwitched();
			expect(switched).toEqual(VITEST_SWITCHES);
			const reported = [...lintFixtures(fixtureDirectory)]
				.filter(([, diagnostics]) => diagnostics.some(({ code }) => code === RULE))
				.map(([file]) => basename(file, '.test.js'))
				.sort();
			expect(reported).toEqual(switched);
		},
		PARALLEL_GATE_TIMEOUT_MS
	);
});
