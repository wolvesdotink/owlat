/**
 * Read a GENERATED, DATA-ONLY artifact back as its value — the one reader.
 *
 * `@owlat/plugin-codegen` emits each catalog as a single
 * `export const NAME = Object.freeze([...]);` statement, and several suites here
 * need the VALUE the host would load rather than the text a grep matched: a
 * pattern match keeps passing after the renderer stops carrying a field, and
 * hand-writing the expected entry pins the copy instead of the source.
 *
 * Three call sites had grown their own version of this — two of them equivalent
 * and one of them not, which is the whole argument for a single declaration. The
 * divergent copy cut the source at the FIRST semicolon anywhere in it, so a
 * manifest whose credential-field label or description contained one ("Issued in
 * the console; written to PLUGIN_ACME_TOKEN") truncated the literal mid-string
 * and died inside `new Function` with a `SyntaxError` naming nothing. The parse
 * here anchors on the STATEMENT's end instead — the renderer emits the
 * declaration last and terminates it — so a semicolon inside a string value is
 * just a character.
 *
 * THE DATA-ONLY GUARD IS THE POINT OF THE FUNCTION, not a precaution around it.
 * An artifact that grew an executable half (an import, a `require`, an arrow) is
 * one that can do work, and every caller here is asking "what data does this
 * carry?" — so the guard fails loudly rather than letting this reader silently
 * evaluate half of something. The module registries, which are import statements
 * by construction, are therefore not readable this way and are not read this way.
 */

/**
 * @param source the whole rendered artifact, header comment included
 * @param constName the exported binding to read, e.g.
 *   `BUNDLED_PLUGIN_SEND_TRANSPORT_CATALOG`
 */
export function evaluateGeneratedArtifact(source: string, constName: string): unknown {
	const marker = `export const ${constName} =`;
	const at = source.indexOf(marker);
	if (at < 0) throw new Error(`the generated artifact does not declare ${constName}`);
	const literal = source
		.slice(at + marker.length)
		.trim()
		.replace(/;\s*$/, '')
		// The only TypeScript in the artifact, and only ever on a literal.
		.replace(/\s+as const\b/g, '');
	if (/\bimport\b|\brequire\b|=>/.test(literal)) {
		throw new Error(`${constName} is no longer a data-only artifact`);
	}
	return new Function(`return ${literal};`)() as unknown;
}
