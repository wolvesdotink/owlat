#!/usr/bin/env bash
#
# ADR numeric-prefix uniqueness guard. Every file in docs/adr/ is named
# `NNNN-slug.md` and is referenced in prose as `ADR-NNNN`. When two files share
# the same `NNNN` prefix (e.g. a module ADR plus its companion execution plan),
# `grep -n ADR-NNNN` and the `NNNN` filename prefix become ambiguous — you can
# no longer tell which document a reference points at.
#
# This is a one-line sibling of scripts/check-dead-code.sh and
# scripts/check-file-size.sh: list the leading 4-digit prefixes of every ADR
# file and fail if `uniq -d` finds any repeat. No baseline — the invariant is
# absolute (one document per number), so a clash is always a bug to fix by
# renumbering the newer document to the end of the sequence.

set -uo pipefail
cd "$(dirname "$0")/.."

adr_dir="docs/adr"

if [ ! -d "$adr_dir" ]; then
	echo "FAIL: $adr_dir not found" >&2
	exit 1
fi

# Leading 4-digit prefix of every `NNNN-*.md` file, sorted, then keep only the
# numbers that appear more than once.
dupes=$(
	find "$adr_dir" -maxdepth 1 -type f -name '[0-9][0-9][0-9][0-9]-*.md' -print \
		| sed -E 's#.*/([0-9]{4})-.*#\1#' \
		| sort \
		| uniq -d
)

if [ -n "$dupes" ]; then
	count=$(printf '%s\n' "$dupes" | grep -c .)
	echo "FAIL: $count ADR numeric prefix(es) used by more than one file in $adr_dir:"
	echo ""
	for n in $dupes; do
		echo "  ADR-$n:"
		find "$adr_dir" -maxdepth 1 -type f -name "$n-*.md" -print | sed 's#^#    #'
	done
	echo ""
	echo "Each ADR number must name exactly one document. Renumber the newer one"
	echo "to the end of the sequence so 'grep -n ADR-NNNN' is unambiguous."
	exit 1
fi

total=$(find "$adr_dir" -maxdepth 1 -type f -name '[0-9][0-9][0-9][0-9]-*.md' | grep -c .)
echo "ok:   all $total ADR numeric prefixes are unique"
