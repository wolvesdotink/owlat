// #region import-provider-module
import type {
	JsonObject,
	PluginImportPageResult,
	PluginImportProviderInput,
	PluginImportProviderModule,
} from '@owlat/plugin-kit';

export const importProvider: PluginImportProviderModule = {
	validateConfig(config: JsonObject) {
		return typeof config['listId'] === 'string'
			? ({ ok: true } as const)
			: ({ ok: false, reason: 'listId is required' } as const);
	},

	async fetchPage(input: PluginImportProviderInput): Promise<PluginImportPageResult> {
		// `cursor` is `''` on the first page; return `null` to end the walk.
		const page = input.cursor === '' ? 1 : Number(input.cursor);
		return {
			rows: [{ email: `contact-${page}@example.com`, fields: { source: 'vendor' } }],
			nextCursor: page >= 2 ? null : String(page + 1),
		};
	},
};
// #endregion import-provider-module
