const PLUGIN_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const MAX_PLUGIN_ID_LENGTH = 64;

declare const pluginIdBrand: unique symbol;

/** A validated, manifest-ownable plugin identity. */
export type PluginId = string & { readonly [pluginIdBrand]: true };

export class PluginIdError extends Error {
	constructor() {
		super('Invalid plugin id');
		this.name = 'PluginIdError';
	}
}

export function parsePluginId(value: unknown): PluginId {
	if (!isPluginId(value)) throw new PluginIdError();
	return value;
}

export function isPluginId(value: unknown): value is PluginId {
	return typeof value === 'string' && value.length <= MAX_PLUGIN_ID_LENGTH && PLUGIN_ID.test(value);
}
