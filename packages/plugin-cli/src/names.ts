/**
 * Identifier derivations shared by every scaffold template.
 *
 * This lives apart from `./scaffold` so the template modules can derive the same
 * names the skeleton does without importing the module that assembles them —
 * `scaffold.ts` imports `scaffoldSendProvider.ts`, so the reverse edge would be a
 * cycle. Keeping the derivation in one place is what lets `sendProviderNames`
 * take a plugin id alone: a camel-case form passed in as an argument is a second
 * source of truth that can disagree with the id, and a bundle whose manifest
 * exports `xPlugin` while its `index.ts` re-exports `yPlugin` does not compile.
 */

/** Derive a lowerCamelCase identifier from a validated kebab-case plugin id. */
export function toCamelCase(id: string): string {
	return id.replace(/-([a-z0-9])/g, (_, char: string) => char.toUpperCase());
}
