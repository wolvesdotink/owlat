import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCodegen } from '../commands/codegen';
import { PluginCliError } from '../errors';
import { captureIo, cleanupCliWorkspaces, createCliWorkspace } from './fixtures';

afterEach(async () => {
	await cleanupCliWorkspaces();
});

const generatedConvexPath = join('apps', 'api', 'convex', 'plugins', 'plugins.generated.ts');

describe('runCodegen', () => {
	it('generates the composition, then reports it current on --check', async () => {
		const root = await createCliWorkspace();
		const generate = captureIo();
		await runCodegen(root, {}, generate.io);
		expect(await readFile(join(root, generatedConvexPath), 'utf8')).toContain('bundled');
		expect(generate.lines.join('\n')).toContain('Generated bundled plugin composition.');

		const check = captureIo();
		await runCodegen(root, { check: true }, check.io);
		expect(check.lines.join('\n')).toContain('Bundled plugin composition is current.');
	});

	it('fails --check as a PluginCliError when generated files are missing or stale', async () => {
		const root = await createCliWorkspace();
		const { io } = captureIo();
		await expect(runCodegen(root, { check: true }, io)).rejects.toThrow(PluginCliError);
	});

	it('validates package boundaries with --boundaries-only', async () => {
		const root = await createCliWorkspace();
		const { io, lines } = captureIo();
		await runCodegen(root, { boundariesOnly: true }, io);
		expect(lines.join('\n')).toContain('Plugin package boundaries are valid.');
	});

	it('rejects mutually exclusive --check and --boundaries-only', async () => {
		const root = await createCliWorkspace();
		const { io } = captureIo();
		await expect(runCodegen(root, { check: true, boundariesOnly: true }, io)).rejects.toThrow(
			/cannot be used together/
		);
	});
});
