# Progressive disclosure

Owlat's UI standard for how much detail a surface shows at once. The goal is
the same as the rest of the design system (Fluid Functionalism): when someone
sits down to do a task, show **that task and nothing else** — summary first,
detail exactly one interaction away. Depth is never deleted; it is layered.

Every surface presents information at one of three levels, and every deeper
level is reachable from the one above it in **one** interaction.

## The three levels

### L1 — Verdict / summary

The default. One line, at most one status chip, at most one number.

- Answers "is this fine, and do I need to act?" — nothing more.
- Emphasis is weight-based (`font-weight: 550` for unread/important), not
  color. Terracotta (`--color-brand`) is reserved for primary actions, links,
  active states, and small indicators.
- A list row shows at most **one** roll-up status chip (plus an optional
  channel chip). Pipeline states, sub-counts, and rates do not belong here.
- Numbers at this level are verdict-shaped: "Healthy", "3 need review",
  "98% delivered" — not a grid of eight raw counters.

### L2 — Inline expansion

One interaction away: an expander, popover, or detail strip that opens **in
place** without navigating.

- Answers "why is that the verdict?" — the breakdown behind the roll-up.
- Opens with `--motion-slow` / `--ease-spring-bounce`, exits with
  `--ease-exit`; honors `prefers-reduced-motion` (opacity-only).
- Must be reachable by keyboard (Enter/Space on the summary element,
  `focus-visible` state on the trigger) and must not shift surrounding layout
  when it is a hover/focus reveal (opacity-only, pointer-events gated).
- Still bounded: an L2 expansion is a paragraph, a short list, or a small
  table — not a dashboard.

### L3 — Dedicated page

A route of its own, for genuinely deep detail: full history, per-item tables,
charts, audit trails.

- Answers "let me investigate" — browsing and analysis, not doing.
- Linked from the L2 expansion (or directly from L1 when there is no useful
  middle ground). The link says where it goes ("View delivery details"),
  never a bare "More".
- Removed or moved routes always get redirects; deep links keep working.

## Choosing a level

Ask, in order:

1. **Does the user need this to decide whether to act?** If not, it is not
   L1. Move it down a level.
2. **Is it needed only when something is wrong?** Then L1 shows the verdict
   ("2 failed") and the breakdown lives at L2. Healthy states earn a single
   quiet line, not a wall of green.
3. **Would a user ever compare rows on this field?** Sorting/filtering
   candidates may stay in list columns; everything else moves inside the item.
4. **Is it multi-dimensional (history, per-recipient, per-step)?** That is
   L3. Do not compress a table into a row of chips to keep it at L1.
5. **When unsure, go deeper.** It is one interaction away, not gone. The
   failure mode we guard against is the noisy dashboard, not the extra click.

Hard rules that fall out of this:

- One status chip per row. If you need two, the second belongs at L2.
- No raw enum strings, confidence percentages, or internal state names at any
  level — controls say what happens, in human language.
- Every L1 → L2 → L3 hop preserves the data: restructuring a surface must not
  lose information, shortcuts, or functionality.

## Before / after examples from this codebase

### 1. Inbox stats grid → filter-pill counts

**Before** — `apps/web/app/pages/dashboard/inbox/index.vue` opened with an
eight-cell stat grid (`Total`, `Open`, `Draft ready`, `Processing`,
`Approved`, `Sent`, `Quarantined`, `Failed`), each a large colored numeral.
Eight L2 breakdowns were promoted to L1, competing with the thread list —
the actual task surface — for attention.

**After** — the counts collapse into the filter pills the page already has:
each pill carries its count as a small `tabular-nums` suffix ("Draft ready
12"). L1 is the thread list plus one verdict line; the per-state numbers are
still visible, but as affordances for filtering (the action they actually
serve) rather than a dashboard. Nothing is lost: every count is still
readable, and clicking a pill filters to those threads.

### 2. Per-message processing pipeline → quiet progress line in the thread

**Before** — the thread view
(`apps/web/app/pages/dashboard/inbox/[threadId].vue`) decorated each message
with a colored processing-status chip (`getProcessingStatusLabel` /
`getProcessingStatusColor`), exposing internal pipeline states on every
message even when processing had finished uneventfully.

**After** — a message that processed cleanly shows nothing. A message still
in flight shows one muted progress line inside the thread ("Drafting a
reply…"); a failed one shows a single verdict chip ("Needs attention") whose
L2 expansion holds the step-by-step trace and the "Retry processing" action.
The full agent trace (`AgentActionTimeline`) remains — moved from
always-rendered to one interaction away.

### 3. Reputation cards → health verdict + trend

**Before** — `apps/web/app/components/reputation/OrgReputationCard.vue`
rendered a grid of metric tiles (bounce rate, complaint rate, totals sent /
delivered / bounced / complaints), each individually colored by threshold.
Reading "am I fine?" required scanning six numbers and knowing the
thresholds.

**After** — L1 is one verdict line with one chip and one number: "Sending
health: Good" plus a small trend mark (shared chart kit, single-series brand
hue). L2 expands to the familiar metric breakdown with the threshold
descriptions; L3 is the reputation settings page with the full per-domain
table (`DomainReputationTable`). The derived rates and totals all survive —
one level down.

## Review checklist

The PR template asks:

> Surfaces lead with a verdict/summary; detail is one interaction away
> (see progressive-disclosure doc).

If your PR adds or restructures a UI surface, check it against the levels
above before requesting review.
