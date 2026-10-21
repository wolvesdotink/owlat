/**
 * Types for the `@owlat/shared/caniemailData` export: the Can I Email dataset
 * snapshot in `src/generated/caniemail-data.json`, refreshed with
 * `bun run update-caniemail`. The export points straight at the JSON, so
 * bundlers load it as data and TypeScript never infers a type from ~1 MB of it.
 * Consumers validate the shape they rely on.
 */
declare const caniemailData: {
	readonly api_version: string;
	readonly last_update_date: string;
	readonly nicenames: unknown;
	readonly data: unknown;
};

/** @public Types the JSON module behind the `./caniemailData` package export. */
export default caniemailData;
