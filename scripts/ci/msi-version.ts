/**
 * Give a prerelease desktop build a Windows Installer version Tauri accepts
 * (see `msiVersion`), by setting `bundle.windows.wix.version` in the release
 * config the build passes to tauri-action. A stable tag leaves the file alone.
 *
 *   TAG=v0.7.0-rc.1 bun scripts/ci/msi-version.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { msiVersion } from './release-policy';

const tag = process.env['TAG'] ?? '';
const version = tag.replace(/^desktop-v|^v/, '');
const msi = msiVersion(version);
if (msi) {
	const path = join(import.meta.dir, '../../apps/desktop/src-tauri/tauri.release.conf.json');
	const config = JSON.parse(readFileSync(path, 'utf8')) as {
		bundle?: { windows?: { wix?: Record<string, unknown> } };
	};
	config.bundle ??= {};
	config.bundle.windows ??= {};
	config.bundle.windows.wix = { ...config.bundle.windows.wix, version: msi };
	writeFileSync(path, `${JSON.stringify(config, null, '\t')}\n`);
	console.info(`MSI version for ${version}: ${msi}`);
} else {
	console.info(`${version} is a stable version; Tauri derives the MSI version.`);
}
