#!/usr/bin/env bash
#
# Reports what a Semgrep scan left unanalysed, from the JSON that
# `semgrep scan --time --json-output <file>` writes. Used by the SAST job in
# .github/workflows/security.yml.
#
#   fixpoint timeouts  `time.fixpoint_timeouts`. Taint analysis of one function
#                      (or of a file's top level) stopped before it finished,
#                      so a taint rule can miss a finding there. Semgrep does
#                      not count these as errors, and the scan still exits 0.
#   errors             `errors`. A rule that failed to load, a file that did
#                      not parse fully, a rule that timed out on a file.
#
# Both go to stdout and, when GITHUB_STEP_SUMMARY is set, to the job summary.
# Each fixpoint timeout is also an `::error` annotation on its function; each
# error-level entry in `errors` is a `::warning` annotation.
#
# Why a timeout fails the job: Semgrep's taint fixpoint budget is a fixed
# 0.2 s of *process* CPU time per function (Limits_semgrep.taint_FIXPOINT_TIMEOUT,
# measured with Sys.time). No CLI option changes it. With several jobs every
# parallel domain spends that same budget, so the count depended on the job
# count and the run. The CI scan runs with `--jobs 1`, where the budget is the
# function's own analysis time and the scan of this repo has no timeouts. A
# timeout under `--jobs 1` is therefore a real regression: a function too
# complex for the analysis to finish.
#
# Usage: check-semgrep-timeouts.sh <semgrep.json>
# Exit:  0 no fixpoint timeouts, 1 fixpoint timeouts, 2 unusable input.

set -euo pipefail

if [ "$#" -ne 1 ]; then
	echo "usage: $0 <semgrep.json>" >&2
	exit 2
fi
report=$1

fail_closed() {
	echo "::error title=Semgrep report unusable::$1"
	if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
		printf '## Semgrep scan coverage\n\n**Report unusable:** %s\n' "$1" >>"$GITHUB_STEP_SUMMARY"
	fi
	exit 2
}

[ -s "$report" ] || fail_closed "$report is missing or empty, so the scan's timeouts and errors cannot be checked."
jq -e 'type == "object"' "$report" >/dev/null 2>&1 ||
	fail_closed "$report is not a JSON object."
# Fixpoint timeouts are only reported under `time`, which needs --time. A
# report without it would read as "no timeouts".
jq -e '(.time.fixpoint_timeouts | type) == "array" and (.errors | type) == "array"' "$report" >/dev/null ||
	fail_closed "$report has no time.fixpoint_timeouts or errors array. Run semgrep with --time --json-output."

# One row per fixpoint timeout: path, line, scope, rule count, first rule.
# The message reads "... at <path>:<line>:<col> [rules: <n>, first: <rule id>]";
# position 1:0 is the file's top-level code rather than a function.
timeouts=$(jq -r '
	.time.fixpoint_timeouts[]
	| (.message // "") as $m
	| ($m | capture("\\[rules: (?<n>[0-9]+), first: (?<rule>[^]]+)\\]") // {n: "?", rule: "?"}) as $r
	| [(.location.path // "?"),
	   (.location.start.line // 1 | tostring),
	   (if ($m | test(":1:0 \\[")) then "top-level code" else "function" end),
	   $r.n, $r.rule]
	| @tsv' "$report")

# One row per error: level, type, where, message on one line (capped).
errors=$(jq -r '
	.errors[]
	| [(.level // "error"),
	   (.type | if type == "array" then .[0] else . end | tostring),
	   (.path // .rule_id // "-"),
	   ((.message // "") | gsub("\\s+"; " ") | .[0:240])]
	| @tsv' "$report")

count_lines() { if [ -z "$1" ]; then echo 0; else printf '%s\n' "$1" | wc -l | tr -d ' '; fi; }
n_timeouts=$(count_lines "$timeouts")
n_errors=$(count_lines "$(printf '%s\n' "$errors" | awk -F'\t' '$1 == "error"')")
n_warnings=$(($(count_lines "$errors") - n_errors))

# Workflow-command values must escape %, CR and LF; properties also , and :.
escape_data() { printf '%s' "$1" | sed -e 's/%/%25/g' -e 's/\r/%0D/g' | awk 'NR > 1 { printf "%%0A" } { printf "%s", $0 }'; }
escape_prop() { escape_data "$1" | sed -e 's/:/%3A/g' -e 's/,/%2C/g'; }
# Markdown table cells: no pipes, no newlines.
cell() { printf '%s' "$1" | sed -e 's/|/\\|/g'; }

echo "Semgrep scan coverage: $n_timeouts fixpoint timeout(s), $n_errors error(s), $n_warnings warning(s)."

if [ "$n_timeouts" -gt 0 ]; then
	echo
	echo "Fixpoint timeouts (taint analysis stopped early; findings in these functions can be missing):"
	while IFS=$'\t' read -r path line scope n rule; do
		echo "  $path:$line  $scope, rules: $n, first: $rule"
		echo "::error file=$(escape_prop "$path"),line=$(escape_prop "$line"),title=Semgrep fixpoint timeout::$(escape_data "Taint analysis of this $scope timed out for $n rule(s) (first: $rule), so their findings here can be missing.")"
	done <<<"$timeouts"
fi

if [ -n "$errors" ]; then
	echo
	echo "::group::Semgrep errors and warnings ($n_errors error(s), $n_warnings warning(s))"
	while IFS=$'\t' read -r level type where message; do
		echo "  [$level] $type  $where  $message"
	done <<<"$errors"
	echo "::endgroup::"
	while IFS=$'\t' read -r level type where message; do
		[ "$level" = error ] || continue
		echo "::warning title=Semgrep $(escape_prop "$type")::$(escape_data "$where: $message")"
	done <<<"$errors"
fi

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
	{
		echo "## Semgrep scan coverage"
		echo
		echo "| | Count |"
		echo "| --- | --- |"
		echo "| Fixpoint timeouts | $n_timeouts |"
		echo "| Errors | $n_errors |"
		echo "| Warnings | $n_warnings |"
		if [ "$n_timeouts" -gt 0 ]; then
			echo
			echo "### Fixpoint timeouts"
			echo
			echo "Taint analysis of these functions stopped before it finished, so taint findings in them can be missing."
			echo
			echo "| Location | Scope | Rules | First rule |"
			echo "| --- | --- | --- | --- |"
			while IFS=$'\t' read -r path line scope n rule; do
				echo "| \`$(cell "$path"):$line\` | $scope | $n | \`$(cell "$rule")\` |"
			done <<<"$timeouts"
		fi
		if [ -n "$errors" ]; then
			echo
			echo "<details><summary>Errors and warnings ($n_errors error(s), $n_warnings warning(s))</summary>"
			echo
			echo "| Level | Type | Where | Message |"
			echo "| --- | --- | --- | --- |"
			while IFS=$'\t' read -r level type where message; do
				echo "| $level | $(cell "$type") | \`$(cell "$where")\` | $(cell "$message") |"
			done <<<"$errors"
			echo
			echo "</details>"
		fi
	} >>"$GITHUB_STEP_SUMMARY"
fi

if [ "$n_timeouts" -gt 0 ]; then
	echo
	echo "Failing: the scan runs with --jobs 1, where this repository has no fixpoint timeouts. See the header of $0."
	exit 1
fi
