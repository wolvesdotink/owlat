/**
 * Version and release-asset naming for the fixture builds, derived from the
 * same sources the Rust updater uses: the `[package]` version and the
 * `repository` URL in apps/desktop/src-tauri/Cargo.toml (updater.rs vets every
 * bundle URL against `<repository path>/releases/download/v<version>/`).
 */

/** The `[package]` version: the first top-level `version = "..."` line. */
export function packageVersion(cargoToml: string): string {
	const match = /^version = "([^"]+)"$/m.exec(cargoToml);
	if (!match) throw new Error('Cargo.toml has no [package] version');
	return match[1]!;
}

/** `/<owner>/<repo>` from the `repository = "https://github.com/..."` line. */
export function repositoryPath(cargoToml: string): string {
	const match = /^repository = "https:\/\/github\.com(\/[^/"]+\/[^/"]+?)\/?"$/m.exec(cargoToml);
	if (!match) throw new Error('Cargo.toml has no github.com repository');
	return match[1]!;
}

/**
 * The release after `version`: the next patch of its core, so a pre-release
 * (`0.7.0-rc.1`) is followed by `0.7.1`, which semver also orders after it.
 */
export function nextVersion(version: string): string {
	const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(version);
	if (!match) throw new Error(`not a semver version: ${version}`);
	return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

/** The file name tauri gives a Linux AppImage. */
export function appImageName(productName: string, version: string): string {
	return `${productName}_${version}_amd64.AppImage`;
}

/** Where a release asset lives under a release host, as updater.rs expects it. */
export function releaseAssetPath(repoPath: string, version: string, fileName: string): string {
	return `${repoPath}/releases/download/v${version}/${encodeURIComponent(fileName)}`;
}

/**
 * The static manifest tauri-action publishes as `latest.json`, reduced to the
 * Linux keys: the plugin looks up `linux-x86_64-appimage` first and falls back
 * to `linux-x86_64`.
 */
export function fixtureManifest(input: {
	readonly version: string;
	readonly url: string;
	readonly signature: string;
}): string {
	const platform = { url: input.url, signature: input.signature };
	return JSON.stringify({
		version: input.version,
		notes: `Fixture release ${input.version}`,
		pub_date: '2026-01-01T00:00:00Z',
		platforms: { 'linux-x86_64': platform, 'linux-x86_64-appimage': platform },
	});
}
