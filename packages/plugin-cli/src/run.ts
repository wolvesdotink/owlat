import type { PackageLoadingOptions } from '@owlat/plugin-codegen';
import { parseArgs, requireNoPositionals, requireSinglePositional } from './args';
import { runCreate } from './commands/create';
import { runCodegen } from './commands/codegen';
import { runMutation } from './commands/mutate';
import { PluginCliError } from './errors';
import type { CliIo } from './io';

export const KNOWN_COMMANDS = ['create', 'add', 'remove', 'codegen', 'dev'] as const;

export interface CliContext {
	readonly workspaceRoot: string;
	readonly io: CliIo;
	/** Test seam for the verified manifest loader; production uses the default import. */
	readonly loadingOptions?: PackageLoadingOptions;
}

export const USAGE = `owlat plugins — manage bundled Owlat plugins

Usage: owlat plugins <command> [options]

Commands:
  create <plugin-id> [--name <package>] [--dir <path>] [--dry-run]
      Scaffold a new plugin package (never installs or executes code).
  add <package> [--dry-run]
      Add a bundled plugin package to plugins.config.ts and preview its
      capability diff. --dry-run previews without writing.
  remove <package> [--dry-run]
      Remove a bundled plugin package from plugins.config.ts.
  codegen [--check] [--boundaries-only]
      Regenerate (or check) the bundled composition via the PP-03 codegen.
  dev
      Regenerate the composition and re-run on every plugins.config.ts change.

Run from anywhere inside the Owlat workspace.`;

/**
 * Route one finite subcommand (everything except the long-running `dev`, whose
 * watcher lifecycle is owned by the entry point). Parsing is strict and happens
 * before any side effect, so a malformed invocation fails cleanly.
 */
export async function dispatchFinite(
	command: string,
	argv: readonly string[],
	context: CliContext
): Promise<void> {
	switch (command) {
		case 'create': {
			const args = parseArgs(argv, { booleans: ['dry-run'], values: ['name', 'dir'] });
			await runCreate(
				context.workspaceRoot,
				{
					idInput: requireSinglePositional(args, 'plugin id'),
					name: args.values.get('name'),
					dir: args.values.get('dir'),
					dryRun: args.booleans.has('dry-run'),
				},
				context.io
			);
			return;
		}
		case 'add':
		case 'remove': {
			const args = parseArgs(argv, { booleans: ['dry-run'] });
			await runMutation(
				command,
				context.workspaceRoot,
				{
					packageInput: requireSinglePositional(args, 'package name'),
					dryRun: args.booleans.has('dry-run'),
				},
				context.io,
				context.loadingOptions
			);
			return;
		}
		case 'codegen': {
			const args = parseArgs(argv, { booleans: ['check', 'boundaries-only'] });
			requireNoPositionals(args, 'codegen');
			await runCodegen(
				context.workspaceRoot,
				{ check: args.booleans.has('check'), boundariesOnly: args.booleans.has('boundaries-only') },
				context.io
			);
			return;
		}
		default:
			throw new PluginCliError(`Unknown command: ${command}`, [
				`Run one of: ${KNOWN_COMMANDS.join(', ')}`,
				'Run "owlat plugins --help" for usage.',
			]);
	}
}
