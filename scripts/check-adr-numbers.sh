#!/usr/bin/env bash
#
# ADR numeric-prefix uniqueness guard, for both ADR series:
#
#   docs/adr/NNNN-slug.md                                  (module ADRs, "ADR-NNNN")
#   apps/docs/content/<locale>/3.developer/decisions/K.NNN-slug.md
#                                                          (product ADRs, "ADR-NNN")
#
# The docs-site files carry a Nuxt Content ordering prefix (`K.`) in front of
# the ADR number; that prefix is not part of the number and is stripped before
# comparing. Each locale directory is checked on its own.
#
# When two files in one series share a number, `grep -n ADR-NNNN` and the
# filename prefix become ambiguous — you can no longer tell which document a
# reference points at. No baseline: the invariant is absolute (one document
# per number within a series), so a clash is always a bug to fix by renumbering
# the newer document to the end of the sequence. The two series deliberately
# overlap in number space; docs/adr/README.md explains how to tell them apart.

set -uo pipefail
cd "$(dirname "$0")/.."

failures=0
total=0

# check_dir <dir> <find-name-glob> <sed-expr extracting the number> <label>
check_dir() {
	local dir="$1" glob="$2" extract="$3" label="$4"

	if [ ! -d "$dir" ]; then
		echo "FAIL: $dir not found" >&2
		failures=$((failures + 1))
		return
	fi

	local files dupes count
	files=$(find "$dir" -maxdepth 1 -type f -name "$glob" -print)
	dupes=$(printf '%s\n' "$files" | sed -E "$extract" | sort | uniq -d)

	if [ -n "$dupes" ]; then
		count=$(printf '%s\n' "$dupes" | grep -c .)
		echo "FAIL: $count $label number(s) used by more than one file in $dir:"
		echo ""
		for n in $dupes; do
			echo "  $label-$n:"
			printf '%s\n' "$files" | grep -E "(/|\.)$n-" | sed 's#^#    #'
		done
		echo ""
		echo "Each ADR number must name exactly one document. Renumber the newer one"
		echo "to the end of the sequence so 'grep -n $label-NNNN' is unambiguous."
		failures=$((failures + 1))
		return
	fi

	count=$(printf '%s\n' "$files" | grep -c .)
	total=$((total + count))
}

# docs/adr: NNNN-slug.md
check_dir docs/adr '[0-9][0-9][0-9][0-9]-*.md' 's#.*/([0-9]{4})-.*#\1#' ADR

# apps/docs: K.NNN-slug.md, one directory per locale
decision_dirs=$(find apps/docs/content -mindepth 3 -maxdepth 3 -type d -path '*/3.developer/decisions' | sort)
if [ -z "$decision_dirs" ]; then
	echo "FAIL: no apps/docs/content/*/3.developer/decisions directory found" >&2
	failures=$((failures + 1))
fi
for d in $decision_dirs; do
	check_dir "$d" '[0-9]*.[0-9][0-9][0-9]-*.md' 's#.*/[0-9]+\.([0-9]{3})-.*#\1#' ADR
done

if [ "$failures" -gt 0 ]; then
	exit 1
fi

echo "ok:   all $total ADR numeric prefixes are unique within their series"
