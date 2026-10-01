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
 *      two accordions in one email no longer close each other's sections
 *      (#1085, #1111).
 */
export const EMAIL_RENDERER_VERSION = 2;
