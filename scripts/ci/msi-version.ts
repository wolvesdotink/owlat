/**
 * Give a prerelease desktop build a Windows Installer version Tauri accepts
 * (see `msiVersion`), by setting `bundle.windows.wix.version` in the release
 * config the build passes to tauri-action. A stable tag leaves the file alone.
 *
 *   TAG=v0.7.0-rc.1 bun scripts/ci/msi-version.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord, JsonShapeError, parseJson } from '../json';
import { msiVersion } from './release-policy';

/** `parent[key]` as an object to edit, created when absent; any other value is an error. */
function section(
	parent: Record<string, unknown>,
	key: string,
	path: string
): Record<string, unknown> {
	const value = parent[key] ?? {};
	if (!isRecord(value)) throw new JsonShapeError(`${path}.${key} must be an object`);
	parent[key] = value;
	return value;
}

/**
 * The release config `text` with `bundle.windows.wix.version` set to `msi`.
 * Every other setting is kept as it was.
 */
export function withMsiVersion(text: string, msi: string, label: string): string {
	const config = parseJson(text, label);
	if (!isRecord(config)) throw new JsonShapeError(`${label} must be an object`);
	const bundle = section(config, 'bundle', label);
	const windows = section(bundle, 'windows', `${label}.bundle`);
	const wix = section(windows, 'wix', `${label}.bundle.windows`);
	wix['version'] = msi;
	return `${JSON.stringify(config, null, '\t')}\n`;
}

if (import.meta.main) {
	const tag = process.env['TAG'] ?? '';
	const version = tag.replace(/^desktop-v|^v/, '');
	const msi = msiVersion(version);
	if (msi) {
		const path = join(import.meta.dir, '../../apps/desktop/src-tauri/tauri.release.conf.json');
		writeFileSync(path, withMsiVersion(readFileSync(path, 'utf8'), msi, 'tauri.release.conf.json'));
		console.info(`MSI version for ${version}: ${msi}`);
	} else {
		console.info(`${version} is a stable version; Tauri derives the MSI version.`);
	}
}
