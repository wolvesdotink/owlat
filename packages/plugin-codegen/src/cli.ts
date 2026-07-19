import { generatePluginComposition } from './generate';
import { PluginCodegenError } from './errors';
import { findWorkspaceRoot } from './workspaceRoot';

const allowedArguments = new Set(['--check', '--boundaries-only']);

async function main(): Promise<void> {
	for (const argument of process.argv.slice(2)) {
		if (!allowedArguments.has(argument)) {
			throw new PluginCodegenError('config_invalid', `Unknown plugin codegen option: ${argument}`);
		}
	}
	const check = process.argv.includes('--check');
	const boundariesOnly = process.argv.includes('--boundaries-only');
	if (check && boundariesOnly) {
		throw new PluginCodegenError(
			'config_invalid',
			'--check and --boundaries-only cannot be used together'
		);
	}

	const workspaceRoot = await findWorkspaceRoot(process.cwd());
	await generatePluginComposition(workspaceRoot, { check, boundariesOnly });
	console.info(
		boundariesOnly
			? 'Plugin package boundaries are valid.'
			: check
				? 'Bundled plugin composition is current.'
				: 'Generated bundled plugin composition.'
	);
}

main().catch((error: unknown) => {
	if (error instanceof PluginCodegenError) {
		console.error(error.message);
		for (const detail of error.details) console.error(`  ${detail}`);
	} else {
		console.error('Plugin codegen failed unexpectedly.');
	}
	process.exitCode = 1;
});
