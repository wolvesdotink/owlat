# ADR-0070: Brand kit — one projection from the settings row to every email

## Status

Accepted.

## Context

An organization could set four email values (primary colour, font,
background, width) on the email theme page. The renderer already understood
far more of a theme (`EmailTheme`: heading font, text and link colours,
per-block defaults), but nothing let an admin set them, the editor offered no
brand colours, and every new email started blank. The workspace logo existed
only for the public pages.

The brand kit had to make every new email start on-brand without changing how
existing emails render, and without a second store of "the brand" next to the
email theme that the server render, the three editors and the settings page
would each read their own way.

## Decision

### 1. Two columns, one resolver

The brand kit lives on the `instanceSettings` singleton. `emailTheme` keeps the
four values it always held; a new `brandKit` column holds the rest (secondary,
text and link colours, swatches, heading font, button style, logo media asset
ids, footer). `workspaces/brandKit.ts` writes both in one mutation.
`settings.update` keeps accepting `emailTheme` for one release, for a settings
tab of the previous release that is still open.

Every reader goes through `resolveBrandKitDesign(emailTheme, brandKit)` and
`brandKitEmailTheme(design)` in `@owlat/shared/brandKit`: the server render
(`loadEmailTheme`), the saved-block rerender, the editors (`useEmailTheme`)
and the settings preview. Until a kit is saved the projection is exactly the
four-key theme the row produced before, so an instance that never opens the
brand kit renders byte for byte as it did.

### 2. The kit reaches existing emails only through the theme

A saved kit adds text and link colours, the heading font, web font URLs
(`EmailTheme.fontUrls`, which the renderer links when the caller passes none)
and per-type `blockDefaults`. The renderer applies those only to fields a
block leaves unset, so saving the kit changes background, width, link colour
and the font of unstyled text in existing emails, and nothing a block set
itself. Restyling an existing email is an explicit, undoable editor action.

### 3. New content starts from the kit

The builder lays `theme.blockDefaults[type]` over a new block's defaults. A
blank template, campaign template or transactional email is created with the
kit's logo and footer blocks; a library preset is restyled with the kit at
creation. Both run on the server (`brandedNewEmailContent`) so every creation
path, including the API, gets them.

### 4. "Apply brand kit" is role-based and conservative

`applyBrandKit` (shared) writes the kit's style fields per block type, clears
per-block font overrides, and never touches content, rich-text inline colours,
or blocks linked to the saved-block library. Text colour is rewritten only on
a surface of the same tone as the kit's background, so light text on a dark
section stays light; a hero image counts as unknown and is left alone.

### 5. Website import goes through the SSRF guard and saves nothing

`importFromWebsite` fetches the page and up to three stylesheets through
`fetchGuarded`, which gained an opt-in `maxRedirects`: each hop is validated
again, so a redirect to a private address is refused like a direct request.
Bodies are read with capped readers and a timeout; the HTML parser is a set of
linear scans. The result is a proposal the admin reviews. Only an accepted
logo is downloaded (PNG, JPEG or script-free SVG, checked by its bytes) into
the media library; the kit itself is saved from the form.

## Consequences

- One kit per organization. Multiple kits, and the kit on forms and the
  public archive, are follow-ups.
- The brand kit logo and the public-page workspace logo are separate settings.
- A web font adds a Google Fonts stylesheet link to emails that use it.
