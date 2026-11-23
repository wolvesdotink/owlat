/**
 * The reference plugins as codegen reads them: each package's OWN root module,
 * not the JSON stub `createDeployment` installs.
 *
 * The lifecycle suites install a stub that re-exports the manifest, so they stay
 * green whatever the real `src/index.ts` exports. This suite installs the real
 * package files and runs the shipped codegen script on them, so a reference that
 * stops default-exporting its manifest, or names an export path its
 * `package.json` lacks, fails here.
 */

import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { REFERENCE_GALLERY } from '../gallery';
import { prepareForScripts, runRepositoryScript } from '../bunScripts';
import { installFromRegistry, packDirectory } from '../registryInstall';
import { REPOSITORY_ROOT } from '../repository';
import { cleanupDeployments, createDeployment, readWorkspaceFile } from '../workspace';

const CONVEX_COMPOSITION = 'apps/api/convex/plugins/plugins.generated.ts';

afterAll(cleanupDeployments);

describe('reference packages as published', () => {
	it('bundles all three through the codegen script from their own default exports', async () => {
		const root = await createDeployment({
			installed: [],
			bundled: REFERENCE_GALLERY.map((entry) => entry.packageName),
		});
		await prepareForScripts(root);
		for (const entry of REFERENCE_GALLERY) {
			await installFromRegistry(root, await packDirectory(join(REPOSITORY_ROOT, entry.directory)));
		}

		const result = runRepositoryScript(root, 'packages/plugin-codegen/src/cli.ts', []);

		expect(result.status, result.output).toBe(0);
		expect(result.output).toContain('Generated bundled plugin composition.');
		const composition = await readWorkspaceFile(root, CONVEX_COMPOSITION);
		for (const entry of REFERENCE_GALLERY) {
			expect(composition).toContain(`from ${JSON.stringify(entry.packageName)};`);
		}
	});
});
