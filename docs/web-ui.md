# Web UI: form controls

One way to build a button or a field in the dashboard (`apps/web/app`).
`bun run lint:ui-controls` (`scripts/check-ui-controls.ts`) enforces the rules
below; it runs in `ci:lint` and `check:changed`.

## Buttons

Use `<UiButton>`. It composes the `.btn` recipe and its `btn-*` variants in
[`components.css`](../packages/ui/assets/css/components.css). A raw `.btn`
class fails the gate.

## Fields

The `.input` recipe in `components.css` is the only definition of the field
look: surface, radius, padding, font size, focus ring, and touch sizing. Its
modifiers sit next to it:

- `.input-sm`: the compact size.
- `.input-error`: the error ring.
- `.input-note`: the tint of an internal note, which the customer never sees.
- `.input-bare`: a control with no chrome of its own, for a surface that already
  draws the field.

`UiInput`, `UiTextarea` and the `UiSelect` trigger compose the recipe. A native
`<input>`, `<select>` or `<textarea>` carries it directly.

### Which control

- A text field with a visible label, help text or an error: `UiInput`. It
  connects the label, sets `aria-invalid` and points `aria-describedby` at the
  error or help text. `UiTextarea` connects its label and shows the error below
  the field, but does not mark the textarea invalid or link the error to it.
  Where a screen reader must hear a textarea's error, use a native
  `<textarea class="input">` and wire `aria-invalid` and `aria-describedby`
  yourself.
- A field that lays out its own label, or needs native behaviour (`time`, `url`
  or `datetime-local` types, `v-model.number`, `v-model.lazy`, saving on
  `change`): the native element with `class="input"`.
- A choice from a list: a native `<select class="input">`. Phones open the
  system picker, and `<optgroup>`, disabled options and typeahead work without
  extra code. `UiSelect` is an app-drawn listbox for a short, flat list whose
  open menu should match the app's own menus. It has no option groups or
  disabled options.
- A control inside a surface that draws the field: `class="input-bare"`.
  Examples are the composer body, the command palette search and the recipient
  chip row. A field with a prefix or chips is a `.input` wrapper around an
  `.input-bare` control. The recipe's ring is `focus-within`, so the wrapper
  shows focus.
- Checkboxes, radios, switches, range, colour and file inputs have their own
  geometry (`UiCheckbox`, `UiSwitch`, `UiSelectableListItem`) and are outside
  these rules.

### What a call site may add

On an element carrying `input`, add layout only: width, margins, flex or grid
placement, textarea height and resize, typeface and weight, text colour,
disabled-state cursor and opacity, and one-sided padding (`pl-10`, `pr-8`,
`pb-8`) that makes room for an icon or an action drawn over the field.

Background, border, radius, shadow, ring, outline, all-round padding and font
size belong to the recipe, and the gate rejects them, including the arbitrary
spellings (`text-[12px]`, `text-(length:--x)`, `[font-size:10px]`,
`[background:none]`). An arbitrary text colour (`text-[#fff]`,
`text-[var(--x)]`) is still a colour and stays allowed. The size comes from
`input-sm`. A control carrying `input-bare` may size its text but draws no
chrome. `class` on `UiInput`, `UiTextarea` or `UiSelect` places the component's
container, so it carries no chrome either.

Spell the recipe where the element is (`class="input"`, or a string literal in
`:class`). A class list held in a variable is invisible to the gate, so it
counts as missing.

When a field needs a look the recipe does not have, add a modifier next to
`.input` in `components.css`. Do not add utilities at the call site. Decoration
that is not the field, such as a card around a composer, goes on a wrapper.

### Touch

On a coarse pointer, `.input` grows to a 44px target with 16px text, and
`.input-bare` gets 16px text. Below 16px, mobile browsers zoom the page when the
field takes focus.
