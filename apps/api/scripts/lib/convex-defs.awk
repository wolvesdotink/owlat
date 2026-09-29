# The one span scanner for top-level public Convex definitions.
#
# Shared by check-permissions, check-query-authz, check-session-threading,
# check-token-redaction and check-errors, which used to carry four copies of
# this state machine plus a fifth variant. A check keeps only its predicate, as
# three hook functions, and runs them through the scanner with
# convex_defs_program from scripts/lib/convex-builders.sh (awk takes either
# `-f` files or program text, so the scanner and the fragment are joined into
# one program):
#
#   program=$(convex_defs_program '
#       function on_start() { … }   # a span opened on this line
#       function on_line()  { … }   # every line of the span, the export and
#                                   # the closing `})` included
#       function on_end()   { … }   # the span closes on this line (after on_line)
#   ')
#   find convex -name '*.ts' … -print0 \
#       | xargs -0 -r awk -v builders="$builders" -v optout='authz|all-members' "$program"
#
# (xargs rather than `find -exec … +`: find rejects any argument containing a
# brace pair, and the program text is full of them.)
#
# Inputs (-v):
#   builders  ERE alternation of builder names (scripts/lib/convex-builders.sh
#             derives it from source). A span opens on
#             `^export const <name> = (<builders>)\(`.
#   optout    ERE alternation of opt-out keywords, e.g. `authz|all-members`,
#             matched as `// <keyword>:`. Empty means the check has none.
#
# State the hooks read:
#   def_name    the exported name
#   def_start   the export line's FNR
#   def_optout  1 once an opt-out comment applies to the span: one in the
#               contiguous `//` block directly above the export, or one on any
#               line of the span so far
#   is_comment  the current line is a `//` comment line
#   is_optout   the current line carries an opt-out comment
#
# Rules this file owns:
#   * The opt-out block above an export carries into the span. `block_optout` is
#     reset by any line that is neither a comment nor an export, so a comment can
#     never leak onto an unrelated later definition.
#   * A span closes on the first column-0 `})`. Top-level definitions sit at
#     column 0 and oxfmt keeps every nested closer indented, so the only
#     column-0 `})` after an export is the definition's own close. check-errors
#     used to close on brace depth instead; over the whole tree both rules end
#     every span on the same line, and brace counting is the weaker of the two
#     because a `{` or `}` inside a string, regex or template literal skews it.
#     Every export line in the tree ends in `({`, so a one-line definition that
#     never reaches a column-0 `})` does not occur.
#   * State resets at the start of every file, so the checks can pass many files
#     to one awk.

FNR == 1 { in_def = 0; block_optout = 0 }
{
	is_comment = ($0 ~ /^[[:space:]]*\/\//)
	is_optout = (optout != "" && $0 ~ ("//[[:space:]]*(" optout "):"))
	is_export = ($0 ~ ("^export const [A-Za-z0-9_]+ = (" builders ")\\("))
}
is_comment && is_optout { block_optout = 1 }
is_export {
	in_def = 1
	def_name = $3
	def_start = FNR
	def_optout = block_optout
	block_optout = 0
	on_start()
}
in_def {
	if (is_optout) def_optout = 1
	on_line()
	if ($0 ~ /^\}\)/) {
		on_end()
		in_def = 0
	}
}
!is_comment && !is_export { block_optout = 0 }
