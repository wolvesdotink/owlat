import { watch } from 'node:fs';
import { generatePluginComposition } from '@owlat/plugin-codegen';
import { type ChangeSignal, createChangeSignal } from '../changeSignal';
import { CONFIG_PATH } from '../config';
import { reportCliFailure } from '../errors';
import type { CliIo } from '../io';

export interface RunDevOptions {
	/** Coalesced change events; each one triggers one codegen run. */
	readonly events: AsyncIterable<void>;
	/** Regenerate the composition once. Defaults to the PP-03 codegen. */
	readonly runCodegen?: () => Promise<void>;
	readonly io: CliIo;
}

/**
 * The `owlat plugins dev` reactive core: regenerate once, then regenerate on
 * every coalesced change event until the event stream ends. A codegen failure
 * (for example an invalid manifest saved mid-edit) is reported and the loop
 * keeps running, so a transient bad edit does not kill the dev session. The
 * event source is injectable, which keeps the loop free of real filesystem
 * watching and timers under test.
 */
export async function runDev(workspaceRoot: string, options: RunDevOptions): Promise<void> {
	const runCodegen = options.runCodegen ?? (() => generatePluginComposition(workspaceRoot));
	const { io } = options;

	await runOnce(runCodegen, io, 'Generated bundled plugin composition.');
	io.log(`Watching ${CONFIG_PATH} for changes. Press Ctrl+C to stop.`);
	for await (const _ of options.events) {
		await runOnce(runCodegen, io, 'Regenerated bundled plugin composition.');
	}
}

async function runOnce(
	runCodegen: () => Promise<void>,
	io: CliIo,
	successMessage: string
): Promise<void> {
	try {
		await runCodegen();
		io.log(successMessage);
	} catch (cause) {
		reportCliFailure(io, cause, 'Plugin codegen failed unexpectedly.');
		io.error('Waiting for the next change...');
	}
}

/**
 * Watch the workspace-root directory (non-recursively) and coalesce every event
 * that touches plugins.config.ts into the returned signal. Watching the parent
 * directory rather than the file itself survives the rename-replace pattern many
 * editors use to save.
 */
export function watchPluginsConfig(workspaceRoot: string, io: CliIo): ChangeSignal {
	const signal = createChangeSignal();
	const watcher = watch(workspaceRoot, { persistent: true }, (_event, filename) => {
		if (filename === CONFIG_PATH) signal.notify();
	});
	watcher.on('error', (error: unknown) => {
		io.error(
			`Stopped watching ${CONFIG_PATH}: ${error instanceof Error ? error.message : 'unknown error'}`
		);
		signal.close();
	});
	const originalClose = signal.close;
	return {
		events: signal.events,
		notify: signal.notify,
		close() {
			watcher.close();
			originalClose();
		},
	};
}
