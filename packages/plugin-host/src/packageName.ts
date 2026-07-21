const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const MAX_PACKAGE_NAME_LENGTH = 214;

declare const pluginPackageNameBrand: unique symbol;

export type PluginPackageName = string & { readonly [pluginPackageNameBrand]: true };

export class PluginPackageNameError extends Error {
	constructor() {
		super('Invalid bundled plugin package name');
		this.name = 'PluginPackageNameError';
	}
}

export function parsePluginPackageName(value: unknown): PluginPackageName {
	if (!isPluginPackageName(value)) throw new PluginPackageNameError();
	return value;
}

export function isPluginPackageName(value: unknown): value is PluginPackageName {
	return (
		typeof value === 'string' &&
		value.length <= MAX_PACKAGE_NAME_LENGTH &&
		value !== '.' &&
		value !== '..' &&
		PACKAGE_NAME.test(value)
	);
}
