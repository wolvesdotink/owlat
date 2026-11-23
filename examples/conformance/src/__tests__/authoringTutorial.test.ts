/**
 * The plugin authoring tutorial, run as written.
 *
 * Every shell command on `41.plugin-authoring.md` runs in order against a
 * checkout-shaped directory (see `../tutorial.ts` for which commands run for
 * real and which are modelled). The run ends where the reader's does: codegen
 * accepts the scaffolded plugin and the generated composition imports it. A page
 * edit that breaks the path, or a CLI change the page does not follow, fails
 * here naming the step.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildScaffold } from '@owlat/plugin-cli/scaffold';
import { parsePluginPackageName } from '@owlat/plugin-host';
import { parsePluginId } from '@owlat/plugin-kit';
import { readRepositoryFile } from '../repository';
import { cleanupTutorialRuns, TutorialRun, tutorialCommands } from '../tutorial';

const ENGLISH = 'apps/docs/content/en/3.developer/41.plugin-authoring.md';
const GERMAN = 'apps/docs/content/de/3.developer/41.plugin-authoring.md';
const CONVEX_COMPOSITION = 'apps/api/convex/plugins/plugins.generated.ts';

afterAll(cleanupTutorialRuns);

async function englishCommands() {
	return tutorialCommands(await readRepositoryFile(ENGLISH));
}

describe('the plugin authoring tutorial', () => {
	it('runs from the scaffold to a composition that bundles the plugin', async () => {
		const commands = await englishCommands();
		const run = await TutorialRun.start();

		for (const command of commands) await run.execute(command);

		const added = commands.findLast((command) => / add @/.test(command.line));
		const packageName = added?.line.split(' ').at(-1) ?? '';
		expect(packageName, 'the tutorial never adds a package').toMatch(/^@[\w-]+\/[\w-]+$/);
		const composition = await readFile(join(run.root, CONVEX_COMPOSITION), 'utf8');
		expect(composition, run.transcript.join('\n')).toContain(
			`from ${JSON.stringify(packageName)};`
		);
	});

	it('is the path `add` prints when it is run on the scaffolded folder', async () => {
		const commands = await englishCommands();
		const firstBundleCommand = commands.findIndex((command) => command.step.startsWith('6.'));
		const addCommand = commands.find(
			(command) => command.step.startsWith('6.') && / owlat-plugins add /.test(command.line)
		);
		expect(firstBundleCommand).toBeGreaterThan(0);
		expect(addCommand, 'step 6 never runs add').toBeDefined();
		const run = await TutorialRun.start();
		for (const command of commands.slice(0, firstBundleCommand)) await run.execute(command);

		const refusal = await run.execute(addCommand!).catch((error: Error) => error.message);

		expect(refusal).toContain('is the workspace package in examples/plugins/');
		const stepSix = commands.filter((command) => command.step.startsWith('6.'));
		for (const command of stepSix.slice(0, -1)) expect(refusal).toContain(`  ${command.line}`);
	});

	it('runs the CLI the way a checkout provides it', async () => {
		const cliCommands = (await englishCommands()).filter((command) =>
			/owlat-plugins|plugin-cli/.test(command.line)
		);
		expect(cliCommands.length).toBeGreaterThan(0);
		for (const command of cliCommands) expect(command.line).toMatch(/^bun run owlat-plugins /);
	});

	it("gives step 2 a manifest that drops into the scaffold's src/manifest.ts", async () => {
		const sample = await readRepositoryFile(
			'packages/plugin-kit/src/__tests__/docsSamples/minimalManifest.ts'
		);
		const create = (await englishCommands()).find((command) =>
			command.line.startsWith('bun run owlat-plugins create ')
		);
		const [, , , , id, , packageName] = create?.line.split(' ') ?? [];
		const index = buildScaffold(
			'/workspace',
			`/workspace/examples/plugins/${id}`,
			parsePluginId(id ?? ''),
			parsePluginPackageName(packageName ?? '')
		).get('src/index.ts');
		// The scaffold's entry re-exports the manifest by name and as the default.
		const named = /export \{ (\w+) \} from '\.\/manifest';/.exec(index ?? '')?.[1];
		expect(index).toContain("export { default } from './manifest';");
		expect(sample).toContain(`export const ${named} = definePlugin({`);
		expect(sample).toContain(`export default ${named};`);
		expect(sample).toContain(`id: '${id}',`);
	});

	it('gives the German page the same commands', async () => {
		const german = tutorialCommands(await readRepositoryFile(GERMAN));
		expect(german.map((command) => command.line)).toEqual(
			(await englishCommands()).map((command) => command.line)
		);
	});
});
