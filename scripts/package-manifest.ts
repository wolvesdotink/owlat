/**
 * The package.json fields the repository scripts read. Every field is optional
 * here because a manifest may leave any of them out; a script that needs one
 * (the release tooling needs `version`) asks for it with `requiredVersion`.
 * Fields no script reads are kept but not checked.
 */
import { readFileSync } from 'node:fs';
import { decodeJson, JsonShapeError, object, optional, recordOf, string } from './json';

const stringMap = optional(recordOf(string));

const decodePackageManifest = object({
	name: optional(string),
	version: optional(string),
	scripts: stringMap,
	dependencies: stringMap,
	devDependencies: stringMap,
	peerDependencies: stringMap,
});

export type PackageManifest = ReturnType<typeof decodePackageManifest>;

/** `text` as a package manifest; `label` names it in errors. */
export function parsePackageManifest(text: string, label: string): PackageManifest {
	return decodeJson(text, decodePackageManifest, label);
}

export function readPackageManifest(path: string): PackageManifest {
	return parsePackageManifest(readFileSync(path, 'utf8'), path);
}

/** The manifest's `version`, which must be present and non-empty. */
export function requiredVersion(manifest: PackageManifest, label: string): string {
	if (!manifest.version) throw new JsonShapeError(`${label}.version must be a non-empty string`);
	return manifest.version;
}
