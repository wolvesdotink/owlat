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
 * NOTHING ELSE READS INSIDE A STRING EITHER, and that is what `maskStrings`
 * below is for. The catalog carries a plugin author's PROSE verbatim (a
 * credential field's `label` and `description` are rendered through
 * `JSON.stringify`), so a description reading "the token you import from the
 * console" or "we require an API key" would otherwise trip the data-only guard
 * with a message naming the wrong cause — the same class of failure as the
 * truncation above — and a value containing " as const" would be silently
 * rewritten. Both the guard and the `as const` strip therefore run over a MASKED
 * view in which every string's content is filler of the same length, so offsets
 * still line up with the real source.
 *
 * THE DATA-ONLY GUARD IS THE POINT OF THE FUNCTION, not a precaution around it.
 * An artifact that grew an executable half (an import, a `require`, an arrow) is
 * one that can do work, and every caller here is asking "what data does this
 * carry?" — so the guard fails loudly rather than letting this reader silently
 * evaluate half of something. The module registries, which are import statements
 * by construction, are therefore not readable this way and are not read this way.
 */

/** Every string literal, blanked to same-length filler so offsets are preserved. */
function maskStrings(source: string): string {
	return source.replace(
		/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g,
		(literal) => `"${'x'.repeat(literal.length - 2)}"`
	);
}

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
		.replace(/;\s*$/, '');
	const masked = maskStrings(literal);
	if (/\bimport\b|\brequire\b|=>/.test(masked)) {
		throw new Error(`${constName} is no longer a data-only artifact`);
	}
	// The only TypeScript in the artifact, and only ever on a literal. Cut from the
	// end so each removal leaves the earlier offsets intact.
	let code = literal;
	for (const match of [...masked.matchAll(/\s+as const\b/g)].reverse()) {
		code = code.slice(0, match.index) + code.slice(match.index + match[0].length);
	}
	return new Function(`return ${code};`)() as unknown;
}
