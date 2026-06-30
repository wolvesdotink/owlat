#!/usr/bin/env bash
# Bans raw `ctx.db.query('knowledgeRelations')` everywhere in apps/api/convex/
# except an allowlist of reviewed, scope-aware seams.
#
# Why this is a hard gate, not a style ratchet: the AI knowledge layer is a
# graph — `knowledgeEntries` (typed nodes) joined by `knowledgeRelations` (typed
# directed edges). Per-node contact isolation is enforced in code by
# `lib/contactScope.ts:isContactScopeVisible(contactIds, scope)`, applied to the
# retrieved candidate pool behind a REQUIRED `scopeToContact` arg. Edges have NO
# scope of their own and CAN join a contact-A node to a contact-B-only node
# (dedup-merge unions `contactIds`). So an edge read is a privilege-escalation
# primitive: any code that follows an edge to a neighbour and surfaces that
# neighbour into a result/context — without re-checking
# `isContactScopeVisible(neighbour.contactIds, scope)` per hop — re-introduces
# the cross-contact data-bleed bug (contact A's draft surfacing contact B's
# knowledge). 'org-wide' is the ONLY scope allowed to skip the per-hop check.
#
# This guard exists to land the security wall BEFORE any edge-traversal code is
# written. The vector lint (`check-contact-scope.sh`) guards `ctx.vectorSearch`
# only and does NOT see `knowledgeRelations` reads — a traversal seam built
# later would be invisible to it. This script closes that gap.
#
# An allowlisted seam MUST satisfy one of:
#   (a) it is unreachable from a contact-scoped AI retrieval path — analytics /
#       dashboard reads are member-trusted publicQuery reads (the caller already
#       proved org membership; no per-contact scoping is in play), or system /
#       cron / deletion-cascade maintenance that does not feed an AI context; OR
#   (b) it re-applies `isContactScopeVisible(neighbour.contactIds, scope)` on
#       every neighbour reached by an edge before that neighbour can enter a
#       result or model context.
#
# Current allowlisted readers (each reviewed against the rule above):
#   - convex/knowledge/graph.ts        getEntry resolves a node's edges for the
#                                      member-trusted dashboard (rule a).
#   - convex/knowledge/edges.ts        the deterministic edge WRITER (`upsertEdge`)
#                                      reads `by_pair` only to merge duplicate
#                                      edges idempotently at construction time —
#                                      it never traverses an edge to a neighbour
#                                      node nor surfaces one into an AI context,
#                                      and refuses cross-contact edges via
#                                      `contactScopesCanLink` (rule a, write path).
#   - convex/knowledge/maintenance.ts  decay/dedup cron deletes the edges of
#                                      expired/merged nodes (rule a, system).
#   - convex/lib/contactMutations.ts   contact merge/delete cascade prunes
#                                      orphaned edges (rule a, member mutation).
#   - convex/organizations/deletion/   org-deletion sweep of the table (rule a).
#
# Pre-allowlisted future seams (files do not exist yet; grep -v on a missing
# path matches nothing, so this is harmless until they land):
#   - convex/knowledge/graphTraversal.ts  graph-augmented retrieval — MUST take
#                                         (b): re-check isContactScopeVisible per
#                                         hop. Enforced positively below once the
#                                         file exists.
#   - convex/knowledge/graphAnalytics.ts  member-trusted analytics reads (a).
#   - convex/knowledge/relationDecay.ts   system edge-decay maintenance (a).
#
# If you add a NEW reader, you are claiming it satisfies (a) or (b). Get it
# reviewed, then add it to the allowlist below with a one-line rationale.
#
# Manual check that this guard actually bites (the negative test):
#   f=convex/__graphscope_probe.ts
#   printf "ctx.db.query('knowledgeRelations')\n" > "$f"
#   bash scripts/check-graph-scope.sh; echo "exit=$?"   # expect FAIL / exit=1
#   rm -f "$f"

cd "$(dirname "$0")/.."

# Matches a real read `*.query('knowledgeRelations'` / `*.query("knowledgeRelations"`.
# A bracket expression on each end keeps this portable (no ERE backreference,
# which BSD/macOS grep does not support). Prose mentions of the table name in
# comments never match because they lack the `.query(` prefix.
PATTERN="\.query\(['\"]knowledgeRelations['\"]"

# The reviewed seams that may read knowledgeRelations directly.
filter() {
	grep -v "/_generated/" \
		| grep -v "/__tests__/" \
		| grep -v "convex/knowledge/graph.ts" \
		| grep -v "convex/knowledge/edges.ts" \
		| grep -v "convex/knowledge/maintenance.ts" \
		| grep -v "convex/lib/contactMutations.ts" \
		| grep -v "convex/organizations/deletion/" \
		| grep -v "convex/knowledge/graphTraversal.ts" \
		| grep -v "convex/knowledge/graphAnalytics.ts" \
		| grep -v "convex/knowledge/relationDecay.ts"
}

violations=$(grep -rnE "$PATTERN" convex --include="*.ts" 2>/dev/null | filter || true)

count=$(printf '%s' "$violations" | grep -c . | tr -d ' ')

if [ "$count" -gt 0 ]; then
	echo "FAIL: $count raw ctx.db.query('knowledgeRelations') read(s) outside the reviewed graph seams."
	echo ""
	echo "$violations"
	echo ""
	echo "Edges (knowledgeRelations) have no contact scope of their own and can join"
	echo "a contact-A node to a contact-B-only node. A new edge reader either must be"
	echo "unreachable from a contact-scoped AI path (member-trusted publicQuery /"
	echo "system maintenance) OR must re-apply isContactScopeVisible(neighbour"
	echo ".contactIds, scope) on every hop before a neighbour enters a result/context"
	echo "('org-wide' is the only scope that may skip it). Route traversal through"
	echo "convex/knowledge/graphTraversal.ts, or add a reviewed seam to the allowlist."
	exit 1
fi

# Positive assertion: once the graph-augmented retrieval seam exists it MUST
# enforce per-hop contact scoping. (check-contact-scope.sh has no equivalent
# positive check — this is the extra teeth this gate adds.)
if [ -f convex/knowledge/graphTraversal.ts ]; then
	if ! grep -q "isContactScopeVisible" convex/knowledge/graphTraversal.ts; then
		echo "FAIL: convex/knowledge/graphTraversal.ts does not call isContactScopeVisible."
		echo ""
		echo "The graph-augmented retrieval seam traverses knowledgeRelations edges, so"
		echo "it MUST re-check isContactScopeVisible(neighbour.contactIds, scope) on every"
		echo "hop before a neighbour enters a result/context. Add the per-hop check."
		exit 1
	fi
fi

echo "ok:   no unscoped knowledgeRelations reads outside the reviewed graph seams"
