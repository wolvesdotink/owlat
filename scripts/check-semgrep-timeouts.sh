#!/usr/bin/env bash
#
# Reports what a Semgrep scan left unanalysed, from the JSON that
# `semgrep scan --time --json-output <file>` writes. The SAST job in
# .github/workflows/security.yml runs the scan through this script.
#
#   fixpoint timeouts  `time.fixpoint_timeouts`. Taint analysis of one function
#                      (or of a file's top level) stopped before it finished,
#                      so a taint rule can miss a finding there. Semgrep does
#                      not count these as errors, and the scan still exits 0.
#   errors             `errors`. A rule that failed to load, a file that did
#                      not parse fully, a rule that timed out on a file.
#
# Both go to stdout and, when GITHUB_STEP_SUMMARY is set, to the job summary.
# Each fixpoint timeout is also an annotation on its function; each
# error-level entry in `errors` is a `::warning` annotation. Errors never fail
# the check; a fixpoint timeout does.
#
# The budget: Semgrep stops a function's taint fixpoint after 0.2 s of
# *process* CPU time (Limits_semgrep.taint_FIXPOINT_TIMEOUT, measured with
# Sys.time). No CLI option changes it. With several jobs every parallel
# domain spends that same budget, so the count depended on the job count and
# the run. The CI scan runs with `--jobs 1`, where the budget is the
# function's own analysis time and the scan of this repo has no timeouts.
# A timeout can still happen there without a code change: GC pressure or a
# slower runner can push a function that sits near the budget over it
# (Semgrep's own source says as much). So --scan re-runs a scan that was
# clean except for fixpoint timeouts once, and passes only if the second
# complete scan has none. Findings fail at once and are never re-run.
#
# Usage:
#   check-semgrep-timeouts.sh <semgrep.json>
#       Check one report.
#   check-semgrep-timeouts.sh --scan <dir> -- <semgrep scan command...>
#       Run the command with `--time --json-output <dir>/semgrep.json`
#       appended, check the report, and re-run once into
#       <dir>/semgrep-retry.json if fixpoint timeouts were the only problem.
# Exit:
#   0 no fixpoint timeouts; 1 fixpoint timeouts; 2 unusable report;
#   with --scan, a failing scan's own exit code (findings: 1).

set -euo pipefail

# jq helpers. Every value is turned into a string with `tostring`, so a
# report with unexpected types still yields one finished line per entry.
#   display  one-line text for the log and the summary: whitespace runs
#            collapse to a space, other control characters become `?`, and
#            `##[` (the runner's legacy command prefix, honoured anywhere in a
#            line) becomes `##(`
#   data     a workflow-command message (actions/toolkit command.ts)
#   prop     a workflow-command property
#   cell     a Markdown table cell: no pipes, no HTML (a `<!--` in a parse
#            error message would hide the rest of the summary), no code
#            spans (they would show the HTML escapes)
JQ_DEFS='
def display: tostring | gsub("\\s+"; " ") | sub("^ "; "") | sub(" $"; "") | explode | map(if . < 32 or . == 127 then 63 else . end) | implode | gsub("##\\["; "##(");
def data: tostring | gsub("%"; "%25") | gsub("\r"; "%0D") | gsub("\n"; "%0A");
def prop: data | gsub(":"; "%3A") | gsub(","; "%2C");
def cell: display | gsub("&"; "&amp;") | gsub("<"; "&lt;") | gsub(">"; "&gt;") | gsub("\\|"; "\\|") | gsub("`"; "'"'"'");
def timeouts:
	.time.fixpoint_timeouts[]
	| ((.message? // "") | tostring) as $m
	| (($m | capture("\\[rules: (?<n>[0-9]+), first: (?<rule>[^]]+)\\]")) // {n: "?", rule: "?"})
	+ {
		path: (.location?.path? // null),
		line: (.location?.start?.line? // null),
		scope: (if ($m | test(":1:0 \\[")) then "top-level code" else "function" end)
	};
def errors:
	.errors[]
	| {
		level: ((.level? // "error") | tostring),
		type: ((.type? // "?") | if type == "array" then (.[0] // "?") else . end | tostring),
		where: ((.path? // .rule_id? // "-") | tostring),
		message: ((.message? // "") | tostring)
	};
'

FAILED_CLOSED=2

# Report text (paths, rule ids, messages, Semgrep's own output) is printed only
# between `::stop-commands::<token>` and `::<token>::`, so the runner does not
# act on a `::command::` or `##[command]` inside it. The token is random per
# run, so a report cannot contain the resume line. On top of that, every such
# line starts with `semgrep-coverage: ` and `display` rewrites `##[`, so the
# text stays inert even outside a suspended block. Annotations are printed
# after the resume, built from the raw values with the toolkit's escaping.
TOKEN="semgrep-coverage-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
SUSPENDED=0
suspend_commands() {
	echo "::stop-commands::$TOKEN"
	SUSPENDED=1
}
resume_commands() {
	echo "::$TOKEN::"
	SUSPENDED=0
}

# Prints a finding about the report itself and exits 2.
fail_closed() {
	if [ "$SUSPENDED" -eq 1 ]; then resume_commands; fi
	echo "::error title=Semgrep report unusable::$(printf '%s' "$1" | sed -e 's/%/%25/g')"
	if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
		printf '## Semgrep scan coverage\n\n**Report unusable:** %s\n' "$1" >>"$GITHUB_STEP_SUMMARY"
	fi
	exit "$FAILED_CLOSED"
}

# query <report> <program> [jq options...]: runs one jq program (with the
# helpers above) against the report. Callers route a failure to bad_report.
query() {
	local report=$1 program=$2
	shift 2
	jq -r "$@" "$JQ_DEFS $program" "$report" 2>/dev/null
}

bad_report() {
	fail_closed "$1 could not be read as a Semgrep report (jq failed on it)."
}

# check_report <report> <label> <timeout annotation level>
# Prints the report's coverage; returns 0 without and 1 with fixpoint timeouts.
check_report() {
	local report=$1 label=$2 level=$3 heading="## Semgrep scan coverage"
	if [ -n "$label" ]; then heading="$heading ($label)"; fi

	[ -s "$report" ] || fail_closed "$report is missing or empty, so the scan's timeouts and errors cannot be checked."
	# Exactly one JSON object: concatenated documents or invalid JSON fail here.
	[ "$(jq -s 'length == 1 and (.[0] | type) == "object"' "$report" 2>/dev/null)" = true ] ||
		fail_closed "$report is not a single JSON object."
	# Fixpoint timeouts are only reported under `time`, which needs --time. A
	# report without it would read as "no timeouts".
	[ "$(query "$report" '(.time.fixpoint_timeouts | type) == "array" and (.errors | type) == "array"')" = true ] ||
		fail_closed "$report has no time.fixpoint_timeouts or errors array. Run semgrep with --time --json-output."

	local counts n_timeouts n_errors n_warnings
	counts=$(query "$report" '[([timeouts] | length), ([errors | select(.level == "error")] | length), ([errors] | length)] | @tsv') ||
		bad_report "$report"
	IFS=$'\t' read -r n_timeouts n_errors n_warnings <<<"$counts"
	n_warnings=$((n_warnings - n_errors))

	echo "Semgrep scan coverage${label:+ ($label)}: $n_timeouts fixpoint timeout(s), $n_errors error(s), $n_warnings warning(s)."

	if [ "$n_timeouts" -gt 0 ]; then
		echo
		echo "Fixpoint timeouts (taint analysis stopped early; findings in these functions can be missing):"
		suspend_commands
		query "$report" 'timeouts
			| "semgrep-coverage: \(.path // "?" | display):\(.line // "?" | display)  \(.scope), rules: \(.n | display), first: \(.rule | display)"' ||
			bad_report "$report"
		resume_commands
	fi

	if [ "$((n_errors + n_warnings))" -gt 0 ]; then
		echo
		echo "::group::Semgrep errors and warnings ($n_errors error(s), $n_warnings warning(s))"
		suspend_commands
		query "$report" 'errors
			| "semgrep-coverage: [\(.level | display)] \(.type | display)  \(.where | display)  \(.message | display | .[0:240])"' ||
			bad_report "$report"
		resume_commands
		echo "::endgroup::"
	fi

	# Annotations, after every suspended block.
	query "$report" '
		(timeouts
		 | "::\($level) "
		   + ([(.path | select(. != null) | "file=\(prop)"),
		       (.line | select(type == "number") | "line=\(.)"),
		       "title=Semgrep fixpoint timeout"] | join(","))
		   + "::"
		   + ("Taint analysis of this \(.scope) timed out for \(.n) rule(s) (first: \(.rule)), so their findings here can be missing." | data)),
		(errors | select(.level == "error") | "::warning title=Semgrep \(.type | prop)::\("\(.where): \(.message)" | data)")' \
		--arg level "$level" || bad_report "$report"

	if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
		local timeout_rows="" error_rows=""
		if [ "$n_timeouts" -gt 0 ]; then
			timeout_rows=$(query "$report" 'timeouts | "| \(.path // "?" | cell):\(.line // "?" | cell) | \(.scope) | \(.n | cell) | \(.rule | cell) |"') ||
				bad_report "$report"
		fi
		if [ "$((n_errors + n_warnings))" -gt 0 ]; then
			error_rows=$(query "$report" 'errors | "| \(.level | cell) | \(.type | cell) | \(.where | cell) | \(.message | .[0:240] | cell) |"') ||
				bad_report "$report"
		fi
		{
			echo "$heading"
			echo
			echo "| | Count |"
			echo "| --- | --- |"
			echo "| Fixpoint timeouts | $n_timeouts |"
			echo "| Errors | $n_errors |"
			echo "| Warnings | $n_warnings |"
			if [ -n "$timeout_rows" ]; then
				echo
				echo "### Fixpoint timeouts"
				echo
				echo "Taint analysis of these functions stopped before it finished, so taint findings in them can be missing."
				echo
				echo "| Location | Scope | Rules | First rule |"
				echo "| --- | --- | --- | --- |"
				echo "$timeout_rows"
			fi
			if [ -n "$error_rows" ]; then
				echo
				echo "<details><summary>Errors and warnings ($n_errors error(s), $n_warnings warning(s))</summary>"
				echo
				echo "| Level | Type | Where | Message |"
				echo "| --- | --- | --- | --- |"
				echo "$error_rows"
				echo
				echo "</details>"
			fi
			echo
		} >>"$GITHUB_STEP_SUMMARY"
	fi

	[ "$n_timeouts" -eq 0 ]
}

# scan <report> <command...>: runs the scan; returns its exit code.
scan() {
	local report=$1 rc=0
	shift
	rm -f "$report"
	suspend_commands
	"$@" --time --json-output "$report" || rc=$?
	resume_commands
	return "$rc"
}

# A scan that failed (findings, or a crash): report what coverage there is,
# without letting an unusable report replace the scan's own exit code.
fail_with_scan() {
	local rc=$1 report=$2 label=$3
	echo
	echo "Semgrep exited $rc (findings or a scan failure). Not re-running."
	if [ -s "$report" ]; then (check_report "$report" "$label" error) || true; fi
	exit "$rc"
}

if [ "${1:-}" = --scan ]; then
	if [ "$#" -lt 4 ] || [ "$3" != -- ]; then
		echo "usage: $0 --scan <dir> -- <semgrep scan command...>" >&2
		exit 2
	fi
	dir=$2
	shift 3
	first="$dir/semgrep.json"
	retry="$dir/semgrep-retry.json"

	rc=0
	scan "$first" "$@" || rc=$?
	[ "$rc" -eq 0 ] || fail_with_scan "$rc" "$first" "first scan"
	rc=0
	check_report "$first" "first scan" warning || rc=$?
	[ "$rc" -eq 0 ] && exit 0

	echo
	echo "Fixpoint timeouts were the only problem. Re-running the scan once; it passes only without any."
	rc=0
	scan "$retry" "$@" || rc=$?
	[ "$rc" -eq 0 ] || fail_with_scan "$rc" "$retry" "re-run"
	rc=0
	check_report "$retry" "re-run" error || rc=$?
	if [ "$rc" -ne 0 ]; then
		echo
		echo "Failing: fixpoint timeouts in two complete scans. See the header of $0."
	fi
	exit "$rc"
fi

if [ "$#" -ne 1 ]; then
	echo "usage: $0 <semgrep.json> | --scan <dir> -- <semgrep scan command...>" >&2
	exit 2
fi
rc=0
check_report "$1" "" error || rc=$?
if [ "$rc" -ne 0 ]; then
	echo
	echo "Failing: fixpoint timeouts. See the header of $0."
fi
exit "$rc"
