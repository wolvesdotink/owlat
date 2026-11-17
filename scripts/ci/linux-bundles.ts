/**
 * Limit a prerelease Linux desktop build to the bundles its version allows
 * (see `linuxBundleTargets`), by setting `bundle.targets` in the release
 * config the build passes to tauri-action. A stable tag leaves the file alone.
 *
 *   TAG=v0.7.0-rc.1 bun scripts/ci/linux-bundles.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord, JsonShapeError, parseJson } from '../json';
import { section } from './msi-version';
import { linuxBundleTargets } from './release-policy';

/**
 * The release config `text` with `bundle.targets` set to `targets`.
 * Every other setting is kept as it was.
 */
export function withBundleTargets(text: string, targets: string[], label: string): string {
	const config = parseJson(text, label);
	if (!isRecord(config)) throw new JsonShapeError(`${label} must be an object`);
	const bundle = section(config, 'bundle', label);
	bundle['targets'] = targets;
	return `${JSON.stringify(config, null, '\t')}\n`;
}

if (import.meta.main) {
	const tag = process.env['TAG'] ?? '';
	const version = tag.replace(/^desktop-v|^v/, '');
	const targets = linuxBundleTargets(version);
	if (targets) {
		const path = join(import.meta.dir, '../../apps/desktop/src-tauri/tauri.release.conf.json');
		writeFileSync(
			path,
			withBundleTargets(readFileSync(path, 'utf8'), targets, 'tauri.release.conf.json')
		);
		console.info(`Linux bundles for ${version}: ${targets.join(', ')}`);
	} else {
		console.info(`${version} is a stable version; Tauri builds every Linux bundle.`);
	}
}
