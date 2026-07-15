import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const convexDirectory = join(workspaceRoot, 'apps/api/convex');

// Convex 1.36's component-definition bundler uses this exact esbuild runtime,
// browser platform, ESM format, target, and condition set. Running it without
// a deployment URL exercises the real package graph that `convex deploy`
// bundles before making any network request.
const result = await build({
	absWorkingDir: workspaceRoot,
	entryPoints: [join(convexDirectory, 'convex.config.ts')],
	bundle: true,
	platform: 'browser',
	format: 'esm',
	target: 'esnext',
	conditions: ['convex', 'module'],
	write: false,
	outdir: '/tmp/owlat-convex-plugin-bundle',
	metafile: true,
});
if (result.outputFiles.length === 0) {
	throw new Error('Convex-compatible bundler did not emit the application definition');
}

const inputs = Object.keys(result.metafile.inputs);
if (!inputs.some((input) => input.endsWith('packages/plugin-host/src/composition.ts'))) {
	throw new Error('Convex-compatible bundle did not include the plugin host composition');
}
if (
	!inputs.some(
		(input) =>
			input.endsWith('packages/plugin-kit/dist/index.js') ||
			input.endsWith('packages/plugin-kit/src/index.ts')
	)
) {
	throw new Error('Convex-compatible bundle did not include the plugin-kit manifest contract');
}

console.info('Convex bundled the validated plugin composition from packaged workspace exports.');
