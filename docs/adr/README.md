# Architecture decision records

Owlat keeps two ADR series, and their numbers overlap on purpose:

- **`docs/adr/NNNN-slug.md`** (this directory, four-digit numbers, cited as
  `ADR-NNNN`) records the backend module-deepening decisions: which module owns
  which table column, where a lifecycle's single writer lives, and so on. These
  are long, code-level documents written for whoever changes that module next.
- **`apps/docs/content/<locale>/3.developer/decisions/`** (three-digit numbers,
  cited as `ADR-NNN`, published on the docs site) records product and platform
  decisions such as the custom email renderer, Convex as the backend, or the
  plugin platform contract. Numbers 049 to 053 there are short summaries of the
  same-numbered documents here.

So `ADR-0009` is the DOI lifecycle module and `ADR-009` is model routing; the
digit count tells them apart. `scripts/check-adr-numbers.sh` (run by
`bun run lint:adr`) fails when a number is reused inside either series.

Every document here states its status near the top, as a `**Status:**` line
or a `## Status` section. ADR-0043 to ADR-0048 are historical: they are the
phased execution plans that accompanied ADR-0003, 0004, 0005, 0006, 0007 and
0020 when that work was split into PRs. The work shipped; the plans stay as a
record of how it was sequenced and are not maintained. They keep their own
numbers so a reference to any number resolves to exactly one file.
