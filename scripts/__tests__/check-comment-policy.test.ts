/**
 * lint:comment-policy reads the comments of the lines a change adds and
 * rejects issue numbers, narration of earlier code, and tags into documents
 * the repository does not hold. The cases cover each rule and the text it must
 * leave alone, the comment extraction per file kind (strings, regular
 * expressions, JSX text, template interpolations and attributes, shell
 * here-documents and YAML scalars are not comments; a command substitution
 * inside a string is code again), the diff parsing, and the gate
 * end to end in a scratch repository: legacy comments, deletions and renames
 * pass, committed, staged, unstaged and untracked additions are read, and a
 * base that cannot be resolved skips locally and fails in CI.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import {
	checkCommentPolicy,
	findingsInFile,
	parseChangedLines,
	unquotePath,
} from '../check-comment-policy';
import {
	type TextPiece,
	isCheckedPath,
	piecesOfFile,
	ruleHits,
	scriptPieces,
	shellCommentPieces,
	vuePieces,
	yamlCommentPieces,
} from '../comment-policy';

const rulesOf = (text: string, kind: TextPiece['kind'] = 'comment') =>
	ruleHits({ text, kind }).map((hit) => `${hit.rule}:${hit.match}`);

describe('ruleHits', () => {
	it.each([
		['// see #1234 for the background', 'issue-reference:#1234'],
		['* Spend admission (#1333): the call is admitted', 'issue-reference:#1333'],
		['// Wiring contract for the flow (PR #166).', 'issue-reference:#166'],
		['// Retry is safe until now: nothing was sent', 'narration:until now'],
		['// Previously the audit page kept a copy of the list', 'narration:Previously'],
		['// previously the cap was lower', 'narration:previously'],
		['# Previously the cap was lower', 'narration:Previously'],
		['<!-- Previously the list was cached -->', 'narration:Previously'],
		[' * - previously the cap was lower', 'narration:previously'],
		['// The cap holds. previously it was lower', 'narration:previously'],
		['// Previously, the cap was lower', 'narration:Previously'],
		['* The leaf used to be dropped before the scan', 'narration:used to be'],
		['// What this PR changes', 'narration:this PR'],
		['* Read on arrival (SPEC §2.4): the gist', 'dangling-document:SPEC §'],
		['// (INBOX_ZERO_PLAN §2.4) the gist', 'dangling-document:INBOX_ZERO_PLAN §'],
		['* The three outcomes of plan §06', 'dangling-document:plan §'],
		["* the plan's §3 table", "dangling-document:plan's §"],
		['// The guard runs first (D13).', 'decision-tag:D13'],
		['* D8: a switch is allowed on a populated corpus', 'decision-tag:D8'],
		['// the shared-inbox floor ADR-0040 set', 'decision-tag:ADR-0040'],
		['* differently from the pre-D8 implementation', 'decision-tag:D8'],
	])('rejects %j', (text, expected) => {
		expect(rulesOf(text)).toEqual([expected]);
	});

	it.each([
		'// quarantine: #1234 the fixture server is flaky on CI',
		'// text colour #333 on #000, never #0123',
		'// the second attempt (#2) is the last one',
		'// links to page#12 and &#123; stay as they are',
		'// restore the previously focused element',
		'// the counter is used to compute the share',
		'// RFC 5321 §4.5.3.2 and CONVENTIONS.md §3 are real documents',
		'// magic bytes `D0 CF 11 E0` and `FF D8 FF`',
		'// 0xD1, ID12, a 3D chart and version D1.5 are not tags',
		'// draws with D3.js; the name is %D1%80%D0%B0.pdf',
		'# cc -D1 sets the flag',
		'// the element previously focused keeps its ring',
	])('accepts %j', (text) => {
		expect(rulesOf(text)).toEqual([]);
	});

	it('reads a lower-case line-opening "previously" as wrapped when the sentence above runs on', () => {
		const continued = (previous: string) =>
			ruleHits({ text: ' * previously focused element', kind: 'comment', previous });
		expect(continued(' * restore the')).toEqual([]);
		expect(continued(' * The ring is drawn.').map((hit) => hit.rule)).toEqual(['narration']);
		expect(continued('/**').map((hit) => hit.rule)).toEqual(['narration']);
	});

	it('reads only document tags in a test title', () => {
		expect(rulesOf("'keeps the previously selected id for #1234'", 'test-title')).toEqual([]);
		expect(rulesOf("'D13: the scan skips the guard (SPEC §4)'", 'test-title')).toEqual([
			'dangling-document:SPEC §',
			'decision-tag:D13',
		]);
	});
});

const commentLines = (pieces: TextPiece[]) =>
	pieces.filter((piece) => piece.kind === 'comment').map((piece) => piece.line);
const titles = (pieces: TextPiece[]) =>
	pieces.filter((piece) => piece.kind === 'test-title').map((piece) => [piece.line, piece.text]);

describe('scriptPieces', () => {
	it('finds line, block and trailing comments on the lines they occupy', () => {
		const source = [
			'// one', // 1
			'const a = 1; // two', // 2
			'/**', // 3
			' * three', // 4
			' */', // 5
			'class B {', // 6
			'\t/** four */', // 7
			'\tm() {}', // 8
			'}', // 9
		].join('\n');
		const pieces = scriptPieces(source, ts.ScriptKind.TS);
		expect(commentLines(pieces)).toEqual(expect.arrayContaining([1, 2, 3, 4, 5, 7]));
		expect(commentLines(pieces)).not.toContain(8);
		expect(pieces.find((piece) => piece.line === 2)?.text).toBe('// two');
	});

	it('does not read strings, templates, regular expressions or JSX text as comments', () => {
		const source = [
			"const a = '// D13 #1234';",
			'const b = `/* SPEC §4 */ ${a}`;',
			'const c = /\\/\\/ D13/;',
			'const d = <p>// D13 until now</p>;',
		].join('\n');
		const pieces = scriptPieces(source, ts.ScriptKind.TSX);
		expect(pieces.flatMap((piece) => ruleHits(piece))).toEqual([]);
	});

	it('reads the title of every test-function call shape', () => {
		const source = [
			"describe('D13: guard', () => {", // 1
			"\tit.each([1])('SPEC §1 %s', () => {});", // 2
			"\ttest.skipIf(true)('plain', () => {});", // 3
			'\tit(`template ${1}`, () => {});', // 4
			"\texpect('D13').toBe('D13');", // 5
			'});',
		].join('\n');
		expect(titles(scriptPieces(source, ts.ScriptKind.TS))).toEqual([
			[1, "'D13: guard'"],
			[2, "'SPEC §1 %s'"],
			[3, "'plain'"],
			[4, '`template ${1}`'],
		]);
	});

	it('reads the title after a tagged-template table', () => {
		const source = [
			'test.each`', // 1
			'\ta    | b', // 2
			'\t${1} | ${2}', // 3
			"`('D13 guard $a', () => {});", // 4
			"describe.skip.each`a | ${1}`('plain', () => {});", // 5
		].join('\n');
		const pieces = scriptPieces(source, ts.ScriptKind.TS);
		expect(titles(pieces)).toEqual([
			[4, "'D13 guard $a'"],
			[5, "'plain'"],
		]);
		expect(pieces.flatMap((piece) => ruleHits(piece)).map((hit) => hit.match)).toEqual(['D13']);
	});

	it('offsets lines by the first line of an embedded script', () => {
		expect(commentLines(scriptPieces('\n// x', ts.ScriptKind.TS, 10))).toEqual([11]);
	});
});

describe('vuePieces', () => {
	it('reads script, template and style comments on their file lines', () => {
		const source = [
			'<script setup lang="ts">', // 1
			'// script note', // 2
			"const label = '<!-- not a comment -->';", // 3
			'</script>', // 4
			'<template>', // 5
			'\t<!-- template note -->', // 6
			'\t<p>{{ label }}</p>', // 7
			'</template>', // 8
			'<style scoped>', // 9
			'/* style note */', // 10
			'</style>', // 11
		].join('\n');
		const pieces = vuePieces(source)!;
		expect(pieces.map((piece) => [piece.line, piece.text.trim()])).toEqual([
			[2, '// script note'],
			[6, '<!-- template note -->'],
			[10, '/* style note */'],
		]);
	});

	it('reads template comment nodes, not comment-like strings in interpolations or attributes', () => {
		const source = [
			'<template>', // 1
			'\t<div :title="\'<!-- until now -->\'" data-x="<!-- D13 -->">', // 2
			'\t\t{{ "<!-- until now -->" }}', // 3
			'\t\t<span v-if="ok"><!-- nested', // 4
			'\t\tnote --></span>', // 5
			'\t</div>', // 6
			'</template>', // 7
		].join('\n');
		expect(vuePieces(source)!.map((piece) => [piece.line, piece.text.trim()])).toEqual([
			[4, '<!-- nested'],
			[5, 'note -->'],
		]);
	});

	it('reads style comments, not strings or urls, and // lines only in preprocessors', () => {
		const source = [
			'<template><p /></template>', // 1
			'<style>', // 2
			'a { content: "/* D13 */"; background: url(https://owlat.example/a.png); }', // 3
			'/* css note */', // 4
			'// not a css comment', // 5
			'</style>', // 6
			'<style lang="scss">', // 7
			'$x: url(//owlat.example/b.png); // scss note', // 8
			"b { content: '// D13'; }", // 9
			'</style>', // 10
		].join('\n');
		expect(vuePieces(source)!.map((piece) => [piece.line, piece.text.trim()])).toEqual([
			[4, '/* css note */'],
			[8, '// scss note'],
		]);
	});

	it('reads a string continued over an escaped line ending as one string', () => {
		const source = [
			'<template><p /></template>', // 1
			'<style>', // 2
			'a { content: "first \\', // 3
			'/* until now */ second"; }', // 4
			"b { content: 'crlf \\\r", // 5
			"/* D13 */ end'; }", // 6
			'/* css note */', // 7
			'</style>', // 8
		].join('\n');
		expect(vuePieces(source)!.map((piece) => [piece.line, piece.text.trim()])).toEqual([
			[7, '/* css note */'],
		]);
	});

	it('answers undefined for a component that does not parse', () => {
		expect(vuePieces('<template><div></template>')).toBeUndefined();
	});
});

const lineTexts = (pieces: TextPiece[]) => pieces.map((piece) => [piece.line, piece.text]);

describe('shellCommentPieces', () => {
	it('reads # comments, not # inside quotes or parameter expansions', () => {
		const source = [
			'#!/usr/bin/env bash', // 1: shebang
			'# D13: a tag', // 2
			"echo \"#1234 is data\" '# also data' $'# ansi'", // 3
			'count=${#items[@]} # trailing #1234', // 4
			'true;# after a separator', // 5
		].join('\n');
		expect(lineTexts(shellCommentPieces(source))).toEqual([
			[2, '# D13: a tag'],
			[4, '# trailing #1234'],
			[5, '# after a separator'],
		]);
	});

	it('treats multiline strings and here-document bodies as data', () => {
		const source = [
			'message="first line', // 1
			'# until now, still the string"', // 2
			"note='a", // 3
			"# D13 in single quotes' # real one", // 4
			'cat <<EOF # opens a here-document', // 5
			'# until now', // 6
			'EOF', // 7
			'cat <<-\'END\' <<"TWO"', // 8
			'\t# D13', // 9
			'\tEND', // 10
			'# SPEC §4', // 11
			'TWO', // 12
			'read -r x <<< "$y" # here-string', // 13
			'echo $(( 1 << n )) # a shift', // 14
			'# after', // 15
		].join('\n');
		expect(lineTexts(shellCommentPieces(source))).toEqual([
			[4, '# real one'],
			[5, '# opens a here-document'],
			[13, '# here-string'],
			[14, '# a shift'],
			[15, '# after'],
		]);
	});
	it('reads here-documents after a completed arithmetic expression', () => {
		const source = [
			"((count++)); cat <<'EOF'", // 1
			'# until now', // 2
			'EOF', // 3
			'echo "$((1 + 2))"; cat <<EOF # opens', // 4
			'# D13', // 5
			'EOF', // 6
			'(( x << 2 )) # a shift, not a here-document', // 7
			'# after', // 8
		].join('\n');
		expect(lineTexts(shellCommentPieces(source))).toEqual([
			[4, '# opens'],
			[7, '# a shift, not a here-document'],
			[8, '# after'],
		]);
	});

	it('reads comments inside a command substitution, even within double quotes', () => {
		const source = [
			'value="$(', // 1
			'  # until now, this was empty', // 2
			'  printf "%s" "# data" # trailing', // 3
			')" # after', // 4
			'other="`printf x # in backquotes`"', // 5
			'nested="$(echo "$(printf y) # inner")"', // 6
			'text="# still a string $HOME"', // 7
		].join('\n');
		expect(lineTexts(shellCommentPieces(source))).toEqual([
			[2, '# until now, this was empty'],
			[3, '# trailing'],
			[4, '# after'],
			[5, '# in backquotes'],
		]);
	});
});

describe('yamlCommentPieces', () => {
	it('reads YAML comments, not # inside block or quoted scalars', () => {
		const source = [
			'# top', // 1
			'message: | # header note', // 2
			'  # until now, data', // 3
			'quoted: "multi', // 4
			'  # D13 in a quoted scalar"', // 5
			'plain: value # trailing', // 6
			'url: https://owlat.example/#12', // 7
		].join('\n');
		expect(lineTexts(yamlCommentPieces(source))).toEqual([
			[1, '# top'],
			[2, '# header note'],
			[6, '# trailing'],
		]);
	});

	it('reads the shell comments of a run: block on their file lines', () => {
		const source = [
			'jobs:', // 1
			'  test:', // 2
			'    steps:', // 3
			'      - run: |', // 4
			'          # shell note', // 5
			'          cat <<EOF', // 6
			'          # heredoc data', // 7
			'          EOF', // 8
			'          echo "# data" # trailing', // 9
			'          value="$(', // 10
			'            # until now, this was empty', // 11
			'          )"', // 12
			'      - with:', // 13
			'          script: |', // 14
			'            # not shell', // 15
		].join('\n');
		expect(lineTexts(yamlCommentPieces(source))).toEqual([
			[5, '# shell note'],
			[9, '# trailing'],
			[11, '# until now, this was empty'],
		]);
	});
});

describe('isCheckedPath', () => {
	it.each([
		['apps/api/convex/a.ts', true],
		['apps/web/app/pages/x.vue', true],
		['scripts/check.sh', true],
		['.github/workflows/test.yml', true],
		['apps/api/convex/_generated/api.d.ts', false],
		['docs/README.md', false],
		['package.json', false],
	])('%s → %s', (path, expected) => {
		expect(isCheckedPath(path)).toBe(expected);
	});
});

describe('parseChangedLines', () => {
	it('collects the new-side lines of every hunk and skips hunk bodies by count', () => {
		const diff = [
			'diff --git a/a.ts b/a.ts',
			'--- a/a.ts',
			'+++ b/a.ts',
			'@@ -1,2 +1,3 @@',
			'-old one',
			'-old two',
			'+new one',
			'++++ b/evil.ts',
			'+new three',
			'@@ -9 +10,0 @@',
			'-deleted only',
			'@@ -20,0 +21 @@',
			'+added',
			'\\ No newline at end of file',
			'diff --git a/gone.ts b/gone.ts',
			'--- a/gone.ts',
			'+++ /dev/null',
			'@@ -1 +0,0 @@',
			'-bye',
			'diff --git a/x\\ty.ts b/x\\ty.ts',
			'--- /dev/null',
			'+++ "b/caf\\303\\251\\ty.ts"',
			'@@ -0,0 +1,2 @@',
			'+one',
			'+two',
			'diff --git a/space name.ts b/space name.ts',
			'--- /dev/null',
			'+++ b/space name.ts\t',
			'@@ -0,0 +1 @@',
			'+three',
			'diff --git "a/caf\\303\\251 x.ts" "b/caf\\303\\251 x.ts"',
			'--- /dev/null',
			'+++ "b/caf\\303\\251 x.ts"\t',
			'@@ -0,0 +1 @@',
			'+four',
		].join('\n');
		const changed = parseChangedLines(diff);
		expect([...changed.keys()]).toEqual(['a.ts', 'café\ty.ts', 'space name.ts', 'café x.ts']);
		expect([...changed.get('a.ts')!]).toEqual([1, 2, 3, 21]);
		expect([...changed.get('café\ty.ts')!]).toEqual([1, 2]);
		expect([...changed.get('space name.ts')!]).toEqual([1]);
	});

	it('unquotes C-style paths and leaves plain ones alone', () => {
		expect(unquotePath('"a\\"b\\\\c"')).toBe('a"b\\c');
		expect(unquotePath('plain/path.ts')).toBe('plain/path.ts');
	});
});

describe('findingsInFile', () => {
	it('reads only the given lines, or every line', () => {
		const text = '// see #1234\n// until now\n';
		expect(findingsInFile('a.ts', text, new Set([2]))!.map((finding) => finding.line)).toEqual([2]);
		expect(findingsInFile('a.ts', text, 'all')!.map((finding) => finding.line)).toEqual([1, 2]);
		expect(findingsInFile('a.md', text, 'all')).toBeUndefined();
	});

	it('links each comment line to the one above, across every file kind', () => {
		const wrapped = '// restore the\n// previously focused element\n';
		const opened = '// The ring is drawn.\n// previously it was not\n';
		expect(findingsInFile('a.ts', wrapped, 'all')).toEqual([]);
		expect(findingsInFile('a.ts', opened, 'all')!.map((finding) => finding.line)).toEqual([2]);
		expect(findingsInFile('a.sh', '# restore the\n# previously focused one\n', 'all')).toEqual([]);
		expect(piecesOfFile('a.yml', '# one\n# two\n')![1]!.previous).toBe('# one');
	});
});

const sandboxes: string[] = [];
afterEach(() => {
	while (sandboxes.length > 0) rmSync(sandboxes.pop()!, { recursive: true, force: true });
});

function git(root: string, args: string[]): string {
	return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function write(root: string, path: string, contents: string): void {
	mkdirSync(dirname(join(root, path)), { recursive: true });
	writeFileSync(join(root, path), contents);
}

/** A scratch repository whose base commit holds legacy comments the gate must not read. */
function repository(): { root: string; base: string } {
	const root = mkdtempSync(join(tmpdir(), 'owlat-comment-policy-'));
	sandboxes.push(root);
	git(root, ['init', '--quiet', '--initial-branch', 'main']);
	git(root, ['config', 'user.email', 'test@example.com']);
	git(root, ['config', 'user.name', 'Comment Policy Test']);
	write(root, 'src/legacy.ts', '// Fixed in #1234 (D13), see SPEC §4.\nexport const a = 1;\n');
	write(
		root,
		'src/clean.ts',
		'// The cap keeps a page under the read limit.\nexport const b = 2;\n'
	);
	git(root, ['add', '.']);
	git(root, ['commit', '--quiet', '-m', 'base']);
	return { root, base: git(root, ['rev-parse', 'HEAD']) };
}

const check = (root: string, env: NodeJS.ProcessEnv) => checkCommentPolicy(root, env);
const against = (root: string, base: string) => check(root, { COMMENT_POLICY_BASE: base });
const found = (result: ReturnType<typeof check>) =>
	result.findings.map((finding) => `${finding.path}:${finding.line}:${finding.rule}`);

describe('checkCommentPolicy', () => {
	it('passes legacy comments on lines the change does not touch', () => {
		const { root, base } = repository();
		write(root, 'src/legacy.ts', '// Fixed in #1234 (D13), see SPEC §4.\nexport const a = 2;\n');
		git(root, ['commit', '--quiet', '-am', 'change the code line']);
		expect(against(root, base)).toMatchObject({ status: 0, findings: [] });
	});

	it('rejects a committed comment line that cites an issue', () => {
		const { root, base } = repository();
		write(
			root,
			'src/clean.ts',
			'// The cap keeps a page under the read limit (#1500).\nexport const b = 2;\n'
		);
		git(root, ['commit', '--quiet', '-am', 'cite an issue']);
		const result = against(root, base);
		expect(result.status).toBe(1);
		expect(found(result)).toEqual(['src/clean.ts:1:issue-reference']);
		expect(result.messages.join('\n')).toContain('src/clean.ts:1: issue-reference: "#1500"');
	});

	it('reads staged, unstaged and untracked additions', () => {
		const { root, base } = repository();
		write(root, 'src/clean.ts', '// Previously the cap was lower.\nexport const b = 2;\n');
		git(root, ['add', 'src/clean.ts']);
		write(
			root,
			'src/legacy.ts',
			'// Fixed in #1234 (D13), see SPEC §4.\n// D8 applies.\nexport const a = 1;\n'
		);
		write(root, 'src/new.sh', '#!/usr/bin/env bash\n# until now this ran twice\n');
		expect(found(against(root, base)).sort()).toEqual([
			'src/clean.ts:1:narration',
			'src/legacy.ts:2:decision-tag',
			'src/new.sh:2:narration',
		]);
	});

	it('passes deletions, renames and the quarantine form', () => {
		const { root, base } = repository();
		write(root, 'src/clean.ts', 'export const b = 2;\n');
		git(root, ['mv', 'src/legacy.ts', 'src/moved.ts']);
		write(
			root,
			'src/skip.test.ts',
			"// quarantine: #1234 the fixture server is flaky\nit.skip('x', () => {});\n"
		);
		git(root, ['add', '.']);
		git(root, ['commit', '--quiet', '-m', 'delete, rename, quarantine']);
		expect(against(root, base)).toMatchObject({ status: 0, findings: [] });
	});

	it('reads committed and staged files whose names hold spaces', () => {
		const { root, base } = repository();
		write(root, 'src/space name.ts', '// until now\nexport const c = 3;\n');
		git(root, ['add', '.']);
		git(root, ['commit', '--quiet', '-m', 'committed space']);
		write(root, 'src/staged name.vue', '<template>\n\t<!-- D13 -->\n</template>\n');
		git(root, ['add', '.']);
		const result = against(root, base);
		expect(found(result).sort()).toEqual([
			'src/space name.ts:1:narration',
			'src/staged name.vue:2:decision-tag',
		]);
	});

	it('rejects a document tag in a new test title', () => {
		const { root, base } = repository();
		write(root, 'src/a.test.ts', "it('holds the send (SPEC §4.2)', () => {});\n");
		expect(found(against(root, base))).toEqual(['src/a.test.ts:1:dangling-document']);
	});

	it("diffs a pull request against its target branch's merge base", () => {
		const { root } = repository();
		const remote = mkdtempSync(join(tmpdir(), 'owlat-comment-policy-remote-'));
		sandboxes.push(remote);
		git(remote, ['init', '--quiet', '--bare']);
		git(root, ['remote', 'add', 'origin', remote]);
		git(root, ['push', '--quiet', 'origin', 'main']);
		git(root, ['checkout', '--quiet', '-b', 'feature']);
		write(root, 'src/clean.ts', '// until now\nexport const b = 2;\n');
		git(root, ['commit', '--quiet', '-am', 'narrate']);
		const result = check(root, { GITHUB_BASE_REF: 'main' });
		expect(found(result)).toEqual(['src/clean.ts:1:narration']);
		expect(result.messages.at(-1)).toContain('origin/main');
	});

	it('keeps the base of a pull request when its target branch moves', () => {
		const { root, base } = repository();
		const remote = mkdtempSync(join(tmpdir(), 'owlat-comment-policy-remote-'));
		sandboxes.push(remote);
		git(remote, ['init', '--quiet', '--bare']);
		git(root, ['remote', 'add', 'origin', remote]);
		git(root, ['push', '--quiet', 'origin', 'main']);
		git(root, ['checkout', '--quiet', '-b', 'feature']);
		write(root, 'src/clean.ts', '// until now\nexport const b = 2;\n');
		git(root, ['commit', '--quiet', '-am', 'narrate']);
		// The target moves after the checkout; the local origin/main stays put.
		git(root, ['push', '--quiet', 'origin', 'HEAD:refs/heads/main']);
		git(root, ['update-ref', 'refs/remotes/origin/main', base]);

		for (const env of [{}, { PR_BASE_SHA: base }]) {
			const result = check(root, { CI: 'true', GITHUB_BASE_REF: 'main', ...env });
			expect(found(result)).toEqual(['src/clean.ts:1:narration']);
		}
		expect(git(root, ['rev-parse', 'origin/main'])).toBe(base);

		git(root, ['update-ref', '-d', 'refs/remotes/origin/main']);
		const pinned = check(root, { CI: 'true', GITHUB_BASE_REF: 'main', PR_BASE_SHA: base });
		expect(found(pinned)).toEqual(['src/clean.ts:1:narration']);
		expect(pinned.messages.at(-1)).toContain(`origin/main at ${base}`);
	});

	it('skips an unresolvable base locally and fails on it in CI', () => {
		const { root } = repository();
		expect(check(root, {})).toMatchObject({ status: 0 });
		expect(check(root, { COMMENT_POLICY_BASE: 'no-such-ref' }).messages[0]).toContain(
			'skipping outside CI'
		);
		expect(check(root, { COMMENT_POLICY_BASE: 'no-such-ref', CI: 'true' })).toMatchObject({
			status: 1,
		});
	});
});
