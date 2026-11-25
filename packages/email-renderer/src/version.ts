/**
 * Version of the HTML this renderer produces. Bump it when rendering the same
 * blocks produces materially different HTML (apps/api/convex/CONVENTIONS.md,
 * "Versioning rules"). Whoever stores rendered HTML records the version that
 * rendered it in `rendererVersion` (emailTemplates, transactionalEmails,
 * shareLinks): the browser editor sends it with every save, and the API's
 * saved-block rerender stamps it after rendering in Node.
 *
 * A leaf module, reachable through the `@owlat/email-renderer/version`
 * subpath, so the Convex runtime can read it without bundling the renderer.
 *
 * History:
 *   1  Output before versions were bumped.
 *   2  A single-open accordion's radio inputs are named after its own Block
 *      (`owlat-accordion-<blockId>`) instead of sharing `owlat-accordion`, so
 *      two accordions in one email no longer close each other's sections.
 *   3  Non-stacking columns sit in a full-width table row, a full-width
 *      button's anchor is `box-sizing:border-box`, a button keeps an explicit
 *      padding of 0, and a table with a border radius keeps separate borders.
 *   4  A root block's margin is a cell outside the table that carries its
 *      background and border. A nested text, image, button or divider item
 *      draws its own padding (unless it is an editor default), margin,
 *      background, border and corner radius. `mobileFontSize` reaches root
 *      headings and nested text.
 *   5  A transactional email's conditional and repeated root Blocks stay in
 *      its HTML and text once each, between region markers the send resolves
 *      against the request's data (`sendTimeBlockLogic`), instead of being
 *      decided without data.
 *   6  Dark mode leaves the text colours of a surface with its own background
 *      (a block without dark colours, a nested container, column or item, or
 *      an inline highlight) as they are, gives `darkTextColor` to the
 *      elements inside its block, and keeps button labels out of the dark
 *      link colour. A full-width block carries its dark colour variables.
 */
export const EMAIL_RENDERER_VERSION = 6;
