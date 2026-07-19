#!/usr/bin/env bun
import { findWorkspaceRoot } from '@owlat/plugin-codegen';
import { runDev, watchPluginsConfig } from './commands/dev';
import { PluginCliError, reportCliFailure } from './errors';
import type { CliIo } from './io';
import { dispatchFinite, USAGE } from './run';

const consoleIo: CliIo = {
	log: (message) => console.info(message),
	error: (message) => console.error(message),
};

async function main(): Promise<void> {
	const [command, ...rest] = process.argv.slice(2);

	if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
		console.info(USAGE);
		return;
	}

	const workspaceRoot = await findWorkspaceRoot(process.cwd());

	if (command === 'dev') {
		if (rest.length > 0)
			throw new PluginCliError(`dev takes no arguments but got: ${rest.join(', ')}`);
		const signal = watchPluginsConfig(workspaceRoot, consoleIo);
		process.once('SIGINT', () => signal.close());
		process.once('SIGTERM', () => signal.close());
		try {
			await runDev(workspaceRoot, { events: signal.events, io: consoleIo });
		} finally {
			signal.close();
		}
		return;
	}

	await dispatchFinite(command, rest, { workspaceRoot, io: consoleIo });
}

main().catch((error: unknown) => {
	reportCliFailure(consoleIo, error, 'owlat plugins failed unexpectedly.');
	process.exitCode = 1;
});
