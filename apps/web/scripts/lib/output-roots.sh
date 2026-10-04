# Sourced by the web lint scanners that walk directories (check-dead-tokens.sh,
# check-icon-names.sh). Generated output lives in fixed directories at a
# package root, a directory holding package.json: build, dist, .output,
# coverage and .turbo. node_modules and .nuxt are generated wherever they
# appear. A source directory that only shares one of those names deeper down
# (components/build/) is still source, so it is still scanned. turbo.json's
# @owlat/web#lint inputs exclude exactly these paths.

OUTPUT_ROOT_NAMES=(build dist .output coverage .turbo)

# Print the package-root output directories of each scan root that is a package.
output_roots() {
	local root name
	for root in "$@"; do
		[ -f "$root/package.json" ] || continue
		for name in "${OUTPUT_ROOT_NAMES[@]}"; do
			printf '%s\n' "${root%/}/$name"
		done
	done
}

# Filter stdin (lines that start with a scanned path) down to source: drop the
# lines under a package-root output directory of any of the scan roots "$@".
drop_output_roots() {
	awk -v prefixes="$(output_roots "$@")" '
		BEGIN { n = split(prefixes, p, "\n") }
		{
			for (i = 1; i <= n; i++) if (p[i] != "" && index($0, p[i] "/") == 1) next
			print
		}'
}
