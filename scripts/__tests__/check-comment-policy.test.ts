/**
 * lint:comment-policy reads every comment in the tree and rejects issue
 * numbers, narration of earlier code, and tags into documents the repository
 * does not hold. The cases cover each rule and the text it must leave alone,
 * the comment extraction per file kind (strings, regular expressions, JSX
 * text, template interpolations and attributes, shell here-documents and YAML
 * scalars are not comments; a command substitution inside a string is code
 * again), and the gate end to end in a scratch repository: a violation in a
 * file no change touches fails, the working tree is read as it is on disk
 * (staged, unstaged and untracked content), and ignored, deleted, generated
 * and exempt files are skipped.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { checkCommentPolicy, findingsInFile } from '../check-comment-policy';
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
import { NO_AUTO_MAINTENANCE } from './gitRepository.testlib';

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

describe('findingsInFile', () => {
	it('reads every line of a checked file kind', () => {
		const text = '// see #1234\n// until now\n';
		expect(findingsInFile('a.ts', text)!.map((finding) => finding.line)).toEqual([1, 2]);
		expect(findingsInFile('a.md', text)).toBeUndefined();
	});

	it('links each comment line to the one above, across every file kind', () => {
		const wrapped = '// restore the\n// previously focused element\n';
		const opened = '// The ring is drawn.\n// previously it was not\n';
		expect(findingsInFile('a.ts', wrapped)).toEqual([]);
		expect(findingsInFile('a.ts', opened)!.map((finding) => finding.line)).toEqual([2]);
		expect(findingsInFile('a.sh', '# restore the\n# previously focused one\n')).toEqual([]);
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

/** A scratch repository whose one commit holds a clean file. */
function repository(): string {
	const root = mkdtempSync(join(tmpdir(), 'owlat-comment-policy-'));
	sandboxes.push(root);
	git(root, ['init', '--quiet', '--initial-branch', 'main']);
	git(root, ['config', 'user.email', 'test@example.com']);
	git(root, ['config', 'user.name', 'Comment Policy Test']);
	git(root, [...NO_AUTO_MAINTENANCE]);
	write(
		root,
		'src/clean.ts',
		'// The cap keeps a page under the read limit.\nexport const b = 2;\n'
	);
	git(root, ['add', '.']);
	git(root, ['commit', '--quiet', '-m', 'base']);
	return root;
}

const found = (result: ReturnType<typeof checkCommentPolicy>) =>
	result.findings.map((finding) => `${finding.path}:${finding.line}:${finding.rule}`);

describe('checkCommentPolicy', () => {
	it('passes a clean tree and the quarantine form', () => {
		const root = repository();
		write(
			root,
			'src/skip.test.ts',
			"// quarantine: #1234 the fixture server is flaky\nit.skip('x', () => {});\n"
		);
		git(root, ['add', '.']);
		git(root, ['commit', '--quiet', '-m', 'quarantine']);
		const result = checkCommentPolicy(root);
		expect(result).toMatchObject({ status: 0, findings: [] });
		expect(result.messages.at(-1)).toBe('check-comment-policy: 2 file(s), ok.');
	});

	it('rejects a violation in a committed file that no change touches', () => {
		const root = repository();
		write(root, 'src/legacy.ts', '// Fixed in #1234, see SPEC §4.\nexport const a = 1;\n');
		git(root, ['add', '.']);
		git(root, ['commit', '--quiet', '-m', 'legacy']);
		// The working tree and the index match HEAD, and there is no remote or base.
		expect(git(root, ['status', '--porcelain'])).toBe('');
		const result = checkCommentPolicy(root);
		expect(result.status).toBe(1);
		expect(found(result)).toEqual([
			'src/legacy.ts:1:issue-reference',
			'src/legacy.ts:1:dangling-document',
		]);
		expect(result.messages.join('\n')).toContain('src/legacy.ts:1: issue-reference: "#1234"');
		expect(result.messages.at(-1)).toContain('2 finding(s) in 2 file(s)');
	});

	it('reads staged, unstaged and untracked content as it is on disk', () => {
		const root = repository();
		write(root, 'src/staged.ts', '// Previously the cap was lower.\nexport const c = 3;\n');
		git(root, ['add', 'src/staged.ts']);
		write(root, 'src/clean.ts', '// The cap holds.\n// D8 applies.\nexport const b = 2;\n');
		write(root, 'src/new.sh', '#!/usr/bin/env bash\n# until now this ran twice\n');
		expect(found(checkCommentPolicy(root)).sort()).toEqual([
			'src/clean.ts:2:decision-tag',
			'src/new.sh:2:narration',
			'src/staged.ts:1:narration',
		]);
	});

	it('skips ignored, deleted, generated and exempt files', () => {
		const root = repository();
		write(root, 'src/doomed.ts', '// see #1234\n');
		write(root, 'src/_generated/api.ts', '// see #1234\n');
		write(root, 'scripts/comment-policy.ts', '// rejects #1234\n');
		write(root, '.gitignore', 'dist/\n');
		git(root, ['add', '.']);
		git(root, ['commit', '--quiet', '-m', 'skipped files']);
		rmSync(join(root, 'src/doomed.ts'));
		write(root, 'dist/out.js', '// see #1234\n');
		expect(checkCommentPolicy(root)).toMatchObject({ status: 0, findings: [] });
	});

	it('reads files whose names hold spaces and non-ASCII characters', () => {
		const root = repository();
		write(root, 'src/space name.ts', '// until now\nexport const c = 3;\n');
		write(root, 'src/café.vue', '<template>\n\t<!-- D13 -->\n</template>\n');
		git(root, ['add', '.']);
		git(root, ['commit', '--quiet', '-m', 'odd names']);
		expect(found(checkCommentPolicy(root)).sort()).toEqual([
			'src/café.vue:2:decision-tag',
			'src/space name.ts:1:narration',
		]);
	});

	it('rejects a document tag in a test title', () => {
		const root = repository();
		write(root, 'src/a.test.ts', "it('holds the send (SPEC §4.2)', () => {});\n");
		expect(found(checkCommentPolicy(root))).toEqual(['src/a.test.ts:1:dangling-document']);
	});
});
