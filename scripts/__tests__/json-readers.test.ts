/**
 * The shared readers of the JSON the scripts consume: package manifests, turbo
 * output, the image lists, oxlint reports and benchmark results. Each one must
 * refuse a document of the wrong shape instead of handing it on typed.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parsePublishedImages, readDockerImages } from '../ci/docker-images';
import { JsonShapeError } from '../json';
import { parseLintReport } from '../lint-diagnostics';
import { parsePackageManifest, requiredVersion } from '../package-manifest';
import { readFamilyResult } from '../perf-bench/familyResult';
import {
	decodeTurboTasks,
	parseTurboGraph,
	parseTurboTasks,
	parseTurboWorkspaces,
} from '../turbo-json';

const sandboxes: string[] = [];
afterEach(() => {
	for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function file(name: string, contents: string): string {
	const dir = mkdtempSync(join(tmpdir(), 'owlat-json-readers-'));
	sandboxes.push(dir);
	const path = join(dir, name);
	writeFileSync(path, contents);
	return path;
}

describe('package manifests', () => {
	it('read the fields scripts use and keep the rest', () => {
		const manifest = parsePackageManifest(
			JSON.stringify({
				name: '@owlat/web',
				version: '1.2.3',
				scripts: { build: 'nuxt build' },
				private: true,
			}),
			'package.json'
		);
		expect(manifest.scripts).toEqual({ build: 'nuxt build' });
		expect(requiredVersion(manifest, 'package.json')).toBe('1.2.3');
	});

	it('refuse a dependency list, a non-string script or a missing version where one is needed', () => {
		expect(() =>
			parsePackageManifest('{"dependencies":["vitest"]}', 'server/package.json')
		).toThrow('server/package.json.dependencies must be an object');
		expect(() => parsePackageManifest('{"scripts":{"build":1}}', 'package.json')).toThrow(
			'package.json.scripts.build must be a string'
		);
		expect(() => parsePackageManifest('[]', 'package.json')).toThrow(JsonShapeError);
		expect(() =>
			requiredVersion(parsePackageManifest('{}', 'package.json'), 'package.json')
		).toThrow('package.json.version must be a non-empty string');
		expect(() => parsePackageManifest('{"version":7}', 'package.json')).toThrow(
			'package.json.version must be a string'
		);
	});
});

describe('turbo output', () => {
	const task = {
		taskId: '@owlat/web#build',
		package: '@owlat/web',
		task: 'build',
		directory: 'apps/web',
		command: 'nuxt build',
		dependencies: ['@owlat/plugin-kit#build'],
	};

	it('reads the task graph, the test tasks and the workspace list', () => {
		const dryRun = JSON.stringify({ tasks: [task, { ...task, command: undefined }] });
		expect(parseTurboGraph(dryRun, 'dry run').tasks[0]!.dependencies).toEqual([
			'@owlat/plugin-kit#build',
		]);
		expect(parseTurboTasks(dryRun, 'dry run').map((t) => t.command)).toEqual([
			'nuxt build',
			undefined,
		]);
		expect(
			parseTurboWorkspaces('{"packages":{"count":1,"items":[{"name":"a","path":"apps/a"}]}}', 'ls')
		).toEqual([{ name: 'a', path: 'apps/a' }]);
		expect(
			decodeTurboTasks({ tasks: { lint: { inputs: ['$TURBO_ROOT$/x'] }, build: {} } }, 'turbo.json')
		).toEqual({
			lint: { inputs: ['$TURBO_ROOT$/x'] },
			build: {},
		});
	});

	it('refuses a graph whose edges or entries are the wrong shape', () => {
		expect(() =>
			parseTurboGraph(
				JSON.stringify({ tasks: [{ ...task, dependencies: '@owlat/plugin-kit#build' }] }),
				'dry run'
			)
		).toThrow('dry run.tasks[0].dependencies must be an array');
		expect(() =>
			parseTurboTasks(JSON.stringify({ tasks: [{ ...task, directory: null }] }), 'dry run')
		).toThrow('dry run.tasks[0].directory must be a string');
		expect(() => parseTurboWorkspaces('{"packages":[]}', 'ls')).toThrow(
			'ls.packages must be an object'
		);
		expect(() => parseTurboWorkspaces('{"packages":{"items":[{"name":"a"}]}}', 'ls')).toThrow(
			'ls.packages.items[0].path must be a string'
		);
		expect(() => decodeTurboTasks({ tasks: { lint: { inputs: 'x' } } }, 'turbo.json')).toThrow(
			'turbo.json.tasks.lint.inputs must be an array'
		);
	});
});

describe('image lists', () => {
	it('keep a CI build entry whole, since the build matrix reads its other fields', () => {
		const path = file(
			'docker-images.json',
			JSON.stringify([
				{
					name: 'web',
					package: '@owlat/web',
					dockerfile: 'apps/web/Dockerfile',
					context: '.',
					cspShellSmoke: true,
				},
			])
		);
		expect(readDockerImages(path)).toEqual([
			{
				name: 'web',
				package: '@owlat/web',
				dockerfile: 'apps/web/Dockerfile',
				context: '.',
				cspShellSmoke: true,
			},
		]);
	});

	it('refuse a CI build entry without its package or Dockerfile', () => {
		const path = file(
			'docker-images.json',
			JSON.stringify([{ name: 'web', dockerfile: 'apps/web/Dockerfile' }])
		);
		expect(() => readDockerImages(path)).toThrow(`${path}[0].package must be a string`);
		expect(() => readDockerImages(file('docker-images.json', '{"web":{}}'))).toThrow(
			'must be an array'
		);
	});

	it('read the published list with its root-compose marker', () => {
		expect(
			parsePublishedImages('[{"name":"web","rootCompose":"ghcr"},{"name":"docs"}]', 'images.json')
		).toEqual([{ name: 'web', rootCompose: 'ghcr' }, { name: 'docs' }]);
		expect(() =>
			parsePublishedImages('[{"name":"web","rootCompose":true}]', 'images.json')
		).toThrow('images.json[0].rootCompose must be a string');
		expect(() => parsePublishedImages('[{"title":"web"}]', 'images.json')).toThrow(
			'images.json[0].name must be a string'
		);
	});
});

describe('oxlint reports', () => {
	const diagnostic = {
		message: 'Unchecked JSON',
		code: 'owlat(no-unchecked-json-cast)',
		severity: 'warning',
		filename: 'scripts/x.ts',
		labels: [{ span: { offset: 3, length: 4, line: 1, column: 4 } }],
		related: [],
	};

	it('read every diagnostic, with or without a code or a label', () => {
		const { code: _code, labels: _labels, ...bare } = diagnostic;
		expect(
			parseLintReport(JSON.stringify({ diagnostics: [diagnostic, bare], number_of_files: 1 }))
		).toEqual([diagnostic, bare]);
	});

	it('refuse a report whose diagnostics are missing or malformed', () => {
		expect(() => parseLintReport('{"number_of_files":1}')).toThrow(
			'oxlint report.diagnostics must be an array'
		);
		expect(() => parseLintReport('Error: config not found')).toThrow(
			'oxlint report is not valid JSON'
		);
		for (const [patch, message] of [
			[{ filename: undefined }, 'oxlint report.diagnostics[0].filename must be a string'],
			[{ code: 42 }, 'oxlint report.diagnostics[0].code must be a string'],
			[
				{ labels: [{ span: { offset: '3', length: 4 } }] },
				'oxlint report.diagnostics[0].labels[0].span.offset must be an integer',
			],
			[{ labels: [{}] }, 'oxlint report.diagnostics[0].labels[0].span must be an object'],
		] as const) {
			expect(() =>
				parseLintReport(JSON.stringify({ diagnostics: [{ ...diagnostic, ...patch }] }))
			).toThrow(message);
		}
		expect(() => parseLintReport('{"diagnostics":[null]}')).toThrow(
			'oxlint report.diagnostics[0] must be an object'
		);
	});
});

describe('benchmark results', () => {
	const result = {
		family: 'structural-sharing',
		title: 'Structural sharing',
		dataset: { rows: 50, source: 'fixture' },
		runtime: { node: 'v24', v8: '13' },
		tasks: [{ name: 'share', opsPerSample: 10, samplesMs: [0.1, 0.2] }],
	};

	it('read a family result as the measurement process wrote it', () => {
		expect(readFamilyResult(file('run-1.json', JSON.stringify(result)))).toEqual(result);
	});

	it('refuse samples that would turn into NaN statistics', () => {
		const bad = { ...result, tasks: [{ name: 'share', opsPerSample: 10, samplesMs: ['0.1'] }] };
		const path = file('run-1.json', JSON.stringify(bad));
		expect(() => readFamilyResult(path)).toThrow(
			`${path}.tasks[0].samplesMs[0] must be a finite number`
		);
		expect(() => readFamilyResult(file('run-1.json', '{"family":'))).toThrow('is not valid JSON');
		expect(() =>
			readFamilyResult(file('run-1.json', JSON.stringify({ ...result, dataset: { rows: null } })))
		).toThrow('.dataset.rows must be a string or a number');
	});
});
