#!/usr/bin/env bash
# Bans raw `ctx.vectorSearch(...)` everywhere in apps/api/convex/ except the two
# reviewed retrieval seams that enforce contact scoping.
#
# Why this is a hard gate, not a style ratchet: vector search runs over the
# `knowledgeEntries` and `semanticFiles` tables, whose rows are linked to
# specific contacts via `contactIds`. The Convex vector indexes can't filter an
# array field, so cross-contact isolation is enforced in code by over-fetching
# and post-filtering through `lib/contactScope.ts:isContactScopeVisible`, behind
# a REQUIRED `scopeToContact` arg. A new call site that reaches for
# `ctx.vectorSearch` directly would bypass that filter and re-introduce the
# cross-contact data-bleed bug (a draft for contact A surfacing contact B's
# knowledge/files) — exactly the class this guard exists to prevent.
#
# All semantic retrieval MUST go through:
#   - convex/knowledge/retrieval.ts          (knowledge graph)
#   - convex/semanticFileProcessing.ts       (semantic files)
# both of which take `scopeToContact` and filter via isContactScopeVisible. The
# org-wide member read path (`assistant.ask`) passes the explicit `'org-wide'`
# sentinel — it does not call vectorSearch directly.
#
# If a genuinely new, non-contact-linked vector index is ever added, extend the
# allowlist below with the new reviewed seam (and make sure it can't read
# contact-scoped rows).

cd "$(dirname "$0")/.."

# Matches a real call `*.vectorSearch(` (optional whitespace before the paren).
# Prose mentions like `ctx.vectorSearch` in comments (no `(`) never match.
PATTERN='\.vectorSearch[[:space:]]*\('

# The reviewed, scope-enforcing retrieval seams.
filter() {
	grep -v "/_generated/" \
		| grep -v "/__tests__/" \
		| grep -v "convex/knowledge/retrieval.ts" \
		| grep -v "convex/semanticFileProcessing.ts"
}

violations=$(grep -rnE "$PATTERN" convex --include="*.ts" 2>/dev/null | filter || true)

count=$(printf '%s' "$violations" | grep -c . | tr -d ' ')

if [ "$count" -gt 0 ]; then
	echo "FAIL: $count raw ctx.vectorSearch() call(s) outside the contact-scoped retrieval seams."
	echo ""
	echo "$violations"
	echo ""
	echo "Vector search over knowledgeEntries / semanticFiles must go through the"
	echo "scope-enforcing functions (convex/knowledge/retrieval.ts,"
	echo "convex/semanticFileProcessing.ts) so contact isolation (lib/contactScope.ts)"
	echo "is applied. Pass a contactId / 'org-general-only' to scope, or the explicit"
	echo "'org-wide' sentinel for the trusted-member read path."
	exit 1
fi

echo "ok:   no unscoped ctx.vectorSearch() outside the contact-scoped retrieval seams"
