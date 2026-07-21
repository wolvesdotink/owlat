import type { PackageLoadingOptions } from '@owlat/plugin-codegen';
import { computeCapabilityDiff } from '../capabilityDiff';
import {
	addPackage,
	CONFIG_PATH,
	parsePackageArgument,
	readPluginsConfig,
	removePackage,
	serializePluginsConfig,
	writePluginsConfig,
} from '../config';
import type { CliIo } from '../io';
import { formatCapabilityDiff } from '../report';

export type MutationKind = 'add' | 'remove';

export interface MutationArgs {
	readonly packageInput: string;
	readonly dryRun: boolean;
}

/**
 * Add or remove one bundled plugin package.
 *
 * The edit is deterministic and idempotent: an already-listed package on `add`
 * (or an absent package on `remove`) is a reported no-op that writes nothing.
 * Before any file is touched, the proposed set is fully validated by loading its
 * manifests through the verified loader and the capability diff is computed;
 * only then is the canonical config written. `--dry-run` prints the diff and the
 * proposed file without writing. A write failure leaves the config unchanged.
 */
export async function runMutation(
	kind: MutationKind,
	workspaceRoot: string,
	args: MutationArgs,
	io: CliIo,
	loadingOptions: PackageLoadingOptions = {}
): Promise<void> {
	const { packages } = await readPluginsConfig(workspaceRoot);
	const packageName = parsePackageArgument(args.packageInput);
	const edit =
		kind === 'add' ? addPackage(packages, packageName) : removePackage(packages, packageName);

	if (!edit.changed) {
		io.log(
			kind === 'add'
				? `${packageName} is already listed in ${CONFIG_PATH}; nothing to do.`
				: `${packageName} is not listed in ${CONFIG_PATH}; nothing to do.`
		);
		return;
	}

	const diff = await computeCapabilityDiff(workspaceRoot, packages, edit.packages, loadingOptions);
	for (const line of formatCapabilityDiff(diff)) io.log(line);

	if (args.dryRun) {
		io.log('');
		io.log(`Dry run: ${CONFIG_PATH} was not modified.`);
		io.log(`Proposed ${CONFIG_PATH}:`);
		for (const line of serializePluginsConfig(edit.packages).split('\n')) {
			io.log(line.length > 0 ? `  ${line}` : '');
		}
		return;
	}

	await writePluginsConfig(workspaceRoot, edit.packages);
	io.log('');
	io.log(
		kind === 'add'
			? `Added ${packageName} to ${CONFIG_PATH}.`
			: `Removed ${packageName} from ${CONFIG_PATH}.`
	);
	io.log('Run `owlat plugins codegen` to regenerate the bundled composition.');
}
