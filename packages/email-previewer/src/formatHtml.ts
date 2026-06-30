// ============================================================
// Pretty-print HTML for the previewer's code view.
//
// Pure, non-reactive string formatter: re-indents an HTML string by splitting
// on tag boundaries and tracking nesting depth. Used by EmailPreviewer.vue.
// ============================================================

export function formatHtml(html: string): string {
	let formatted = html;
	let indent = 0;
	const tab = '  ';

	formatted = formatted.replace(/>\s*</g, '>\n<');
	const lines = formatted.split('\n');

	return lines
		.map((line) => {
			line = line.trim();
			if (!line) return '';

			if (line.match(/^<\/\w/)) {
				indent = Math.max(0, indent - 1);
			}

			const indented = tab.repeat(indent) + line;

			if (
				line.match(/^<\w/) &&
				!line.match(/\/>$/) &&
				!line.match(/^<(br|hr|img|input|meta|link)/i)
			) {
				indent++;
			}

			return indented;
		})
		.filter(Boolean)
		.join('\n');
}
