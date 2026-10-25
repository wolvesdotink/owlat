import type { BlockChangeKind, RenderContext } from '../types';

/**
 * How a version comparison marks a changed Block in its preview. The colours
 * are the app's light-theme status tokens (success, error, warning, info):
 * the preview paper is white in both app themes. The line style differs per
 * kind too, so the marks do not rely on colour alone.
 */
const OUTLINE_STYLE: Readonly<Record<BlockChangeKind, string>> = {
	added: 'outline:2px solid #55744b;outline-offset:-2px',
	removed: 'outline:2px dashed #a85545;outline-offset:-2px',
	edited: 'outline:3px double #8a6a25;outline-offset:-3px',
	moved: 'outline:2px dotted #46748f;outline-offset:-2px',
};

const own = (record: object, key: string): boolean =>
	Object.prototype.hasOwnProperty.call(record, key);

/**
 * `html` inside an outline when the comparison marked Block `id`, else `html`
 * untouched. Only a render given `diffOutlines` (a comparison preview) is ever
 * marked; the wrapper is a plain `<div>`, valid wherever a Block's markup is.
 */
export function outlineChangedBlock(id: string, html: string, ctx: RenderContext): string {
	const outlines = ctx.diffOutlines;
	if (!outlines || !html || !own(outlines, id)) return html;
	const kind = outlines[id]!;
	if (!own(OUTLINE_STYLE, kind)) return html;
	return `<div data-owlat-diff="${kind}" style="${OUTLINE_STYLE[kind]}">${html}</div>`;
}
