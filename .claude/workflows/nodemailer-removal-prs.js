export const meta = {
	name: 'nodemailer-removal-prs',
	description:
		'Auto-merging per-piece PR pipeline for the 2026-07-11 "Owning the Wire" plan (replace nodemailer with in-house packages/mail-message + packages/smtp-client across MTA, API relay adapter and mail-sync, plus 4 capability follow-ups): 15 pieces on the integration/own-the-wire branch, then ONE giant human-merged PR (F1) taking main from all-nodemailer to zero-nodemailer atomically. For each piece: one BUILDER thread (Opus) implements it IN A DEDICATED GIT WORKTREE (off origin/integration/own-the-wire) with atomic commits and opens a PR targeting integration/own-the-wire; GitHub Actions verifies the push; ONE unified reviewer thread (Fable, latching to Opus if Fable dies) reviews Security + Code Quality + Functionality/Tests + the Fowler code-smell catalog + per-stack best practices AND ENFORCES THE HARD TEST GATE; the AUTHOR thread (Opus) loops addressing EVERY finding until the reviewer approves; then — on approval AND green GitHub CI — a MERGE thread (Sonnet) squash-merges the PR into the integration branch. Waves are barriers; after each wave main is merged INTO the integration branch (trunk wins). X pieces are optional (a permanent failure drops the capability, noted in F1); a failed migration piece blocks F1. F1 opens the giant PR main <- integration/own-the-wire and STOPS at approved+green — Marcel merges it by hand. The pipeline NEVER merges to main.',
	phases: [
		{
			title: 'Build',
			detail: 'Opus builders open PRs vs integration/own-the-wire from scratchpad worktrees',
			model: 'opus',
		},
		{ title: 'Verify', detail: 'wait for GitHub Actions CI (gh pr checks)' },
		{
			title: 'Review',
			detail:
				'one unified reviewer per PR (security + quality + functionality + TEST GATE + smells + best practices)',
			model: 'fable',
		},
		{
			title: 'Address',
			detail: 'Opus author fixes every finding, small improvements included',
			model: 'opus',
		},
		{
			title: 'Merge',
			detail:
				'approved + CI green -> Sonnet squash-merge into the integration branch (F1: human merge)',
			model: 'sonnet',
		},
		{
			title: 'Sync',
			detail: 'after each wave: merge main INTO integration/own-the-wire (trunk wins)',
			model: 'opus',
		},
	],
};

// ===========================================================================
// Constants
// ===========================================================================
const REPO = 'wolvesdotink/owlat'; // == `origin` remote
const BASE = 'integration/own-the-wire'; // piece PRs target THIS branch (never main)
const MAIN = 'main'; // merged INTO the integration branch after each wave; F1 targets it (human-merged)
const MAX_ROUNDS = 4; // review<->address rounds before escalating to a human
const CI_POLLS = 8; // bounded CI-wait iterations (~120s each)
const ROOT = '/home/marcel/Code/Owlat';
const SCRATCH = '/tmp/claude-owlat/own-the-wire-wt';
const AUTO_MERGE = true; // squash-merge into the integration branch on approve+green
const MERGE_ATTEMPTS = 3; // merge tries per piece; a conflict spawns an Opus resolver between tries
const ABORT_IF_WHOLE_WAVE_FAILS = true;

// ===========================================================================
// THE PRODUCT BRIEF — shared by every builder/reviewer so 16 independent PRs
// converge on ONE migration. Locked decisions come from §04 of the reviewed
// 2026-07-11 plan (nodemailer-removal-plan.html); deviations are review-blocking.
// ===========================================================================
const BRIEF =
	`PRODUCT BRIEF — "Owning the Wire" (2026-07-11 plan: replace nodemailer with an in-house SMTP client + MIME composer):\n` +
	`GOAL: nodemailer does two jobs for us — SMTP wire protocol and MIME composition. Replace both with two workspace packages we fully control: packages/mail-message (pure message construction: composeMessage(input) -> { raw, messageId, envelope }, RFC 2047 header encoding/folding, QP/base64 bodies, attachments, plus signMessage(raw, key) DKIM-over-bytes) and packages/smtp-client (a small explicit state machine over net/tls sockets: SmtpClient.connect(...) with client.secured + client.capabilities, client.send(...) with per-recipient RCPT verdicts and structured replies, throwing SmtpError { phase: 'connect'|'greeting'|'ehlo'|'starttls'|'auth'|'mail'|'rcpt'|'data'|'data-final', replyCode?, enhancedCode?, secured, tlsCause?: 'cert-expired'|'cert-host-mismatch'|'cert-untrusted'|'starttls-unavailable'|'handshake' }). Downstream code consumes DATA, not log lines: tlsSecuredCapture.ts, classifyTlsFailure's string tables, and classifySmtpError's message sniffing all get DELETED, not adapted.\n` +
	`LOCKED DECISIONS (do not relitigate; veto window closed):\n` +
	`D1. TWO packages: mail-message is pure and Convex-'use node'-safe (zero runtime deps beyond node:crypto — nodemailer + mailparser survive ONLY as its devDependencies for differential/golden tests); smtp-client is node-only. One package would smear that boundary.\n` +
	`D2. Body encoding ALWAYS 7-bit safe (quoted-printable / base64), all versions, permanently — no 8BITMIME, ever. Compose ONCE per job; byte-identical across MX retries (DKIM-stable). Deterministic given seeded boundary/date inputs.\n` +
	`D3. The MIGRATION preserves one-connection-per-send semantics (today's "pool" caches transport configs, not sockets). True RSET-based socket reuse is piece X1 ONLY — it must not leak into migration pieces.\n` +
	`D4. AUTH PLAIN + LOGIN in v1, and ONLY after the connection is secured unless the host is loopback (the mail-sync invariant, enforced IN THE CLIENT before credentials are serialized). XOAUTH2 is piece X4. CRAM-MD5 / DIGEST-MD5: never (deprecated MD5 constructions).\n` +
	`D5. Sequential command/reply in v1 — trivially auditable during the risky part. PIPELINING (RFC 2920) is piece X2, strictly capability-gated, semantics-identical.\n` +
	`D6. During the migration, envelope domains are IDN-encoded via punycode and non-ASCII localparts are rejected at composition (exactly today's behavior). SMTPUTF8/EAI is piece X3, fail-closed when the server does not advertise it (a UTF-8 localpart cannot be downgraded).\n` +
	`D7. Atomic cutover per call site: no runtime flags, no back-compat shims (pre-prod convention) — when a call site cuts over, the old path is deleted in the SAME PR. main never carries a half-migrated state: everything lands via ONE giant human-merged PR (F1).\n` +
	`D8. Inbound is OUT OF SCOPE: smtp-server (inbound listener), mailparser, mailauth, imapflow all stay. mailauth is load-bearing as the INDEPENDENT verifier of our DKIM output in tests — our own code never verifies itself. CHUNKING/BDAT: never.\n` +
	`SEMANTICS-PRESERVING IS THE DEFAULT: TLS-RPT result types (these feed reports we send to other mail operators — truthfulness is non-negotiable: cleartext success still records starttls-not-supported, never success; enforce-mode cert failures still reach sts-webpki-invalid), the EmailErrorCode taxonomy (incl. AMBIGUOUS_TIMEOUT double-delivery semantics: phase data/data-final with no reply is NEVER auto-retried), 4xx/5xx/5.2.2 bounce classification, MTA-STS enforce/testing behavior, per-IP EHLO names, VERP envelopes, and pool accounting (Redis global cap reserve/release) must be PROVABLY unchanged — the reviewer treats any silent behavior delta as blocking.\n` +
	`STRING-MATCHING ON ERROR MESSAGES IS BANNED in new code: everything classifies on SmtpError.phase / .tlsCause / reply codes.\n` +
	`THE "EVERYTHING TESTED" CONTRACT: every piece card names its test surfaces — that list is the merge gate. vitest only (never bun test); integration tests run against in-process smtp-server (already a dep) or raw net/tls fake servers on ephemeral ports — never the real network; fixtures checked in.\n` +
	`PRE-PROD POSTURE: clean breaking changes over back-compat ceremony; no speculative seams; delete dead code your change orphans; keep diffs strictly within the piece's file scope.`;

// ===========================================================================
// THE UNIFIED REVIEWER — one agent covers Security + Code Quality +
// Functionality/Tests (incl. the HARD TEST GATE) + the code-smell catalog +
// per-stack best practices.
// ===========================================================================
const SMELLS =
	`CODE-SMELL CATALOG — walk the diff against EVERY entry; report each hit with file:line and the prescribed fix:\n` +
	`- Mysterious Name — a function, variable, or type whose name doesn't reveal what it does or holds. -> rename it; if no honest name comes, the design's murky.\n` +
	`- Duplicated Code — the same logic shape appears in more than one hunk or file in the change. -> extract the shared shape, call it from both.\n` +
	`- Feature Envy — a method that reaches into another object's data more than its own. -> move the method onto the data it envies.\n` +
	`- Data Clumps — the same few fields or params keep travelling together (a type wanting to be born). -> bundle them into one type, pass that.\n` +
	`- Primitive Obsession — a primitive or string standing in for a domain concept that deserves its own type. -> give the concept its own small type.\n` +
	`- Repeated Switches — the same switch/if-cascade on the same type recurs across the change. -> replace with polymorphism, or one map both sites share.\n` +
	`- Shotgun Surgery — one logical change forces scattered edits across many files in the diff. -> gather what changes together into one module.\n` +
	`- Divergent Change — one file or module is edited for several unrelated reasons. -> split so each module changes for one reason.\n` +
	`- Speculative Generality — abstraction, parameters, or hooks added for needs the spec doesn't have. -> delete it; inline back until a real need shows.\n` +
	`- Message Chains — long a.b().c().d() navigation the caller shouldn't depend on. -> hide the walk behind one method on the first object.\n` +
	`- Middle Man — a class or function that mostly just delegates onward. -> cut it, call the real target direct.\n` +
	`- Refused Bequest — a subclass or implementer that ignores or overrides most of what it inherits. -> drop the inheritance, use composition.\n`;

const BEST_PRACTICES =
	`PER-STACK BEST PRACTICES — hold the diff to the idioms of each stack it touches:\n` +
	`- TypeScript strict: discriminated unions over boolean flags (SmtpError.phase/tlsCause ARE discriminants — exploit them); as-const/satisfies where they tighten types; no non-null assertions where a guard is honest; narrow at the boundary, not at every use site; no new \`any\` (unknown + narrowing).\n` +
	`- Node sockets (net/tls): every socket path handles 'error'+'close'+'timeout' without leaking listeners or FDs (removeListener/once discipline; check with an event-leak eye); write() backpressure honored (false -> wait for 'drain'); every timer cleared on every exit path; racing socket events must not produce unhandled rejections or double-settled promises; destroy() vs end() chosen deliberately.\n` +
	`- Protocol code: the state machine is explicit (no implicit state in closures scattered across callbacks); parsers are tolerant in what they accept, strict in what they emit; every deliberate RFC deviation carries a comment citing the RFC section; CRLF discipline everywhere (bare LF normalized, never emitted).\n` +
	`- Vitest: test behavior not implementation; deterministic (no real timers where fake ones do, no external network — in-process servers on ephemeral ports); table-driven where cases repeat; fixtures checked in as bytes; integration tests clean up sockets/servers in afterEach so suites don't hang.\n` +
	`- Convex (C2 only): follow apps/api/convex/CONVENTIONS.md; 'use node' actions only where net/crypto requires; env access ONLY via lib/env.ts (lint:env blocks direct process.env).\n` +
	`- Monorepo hygiene: new packages mirror packages/shared's conventions (package.json name/exports, tsconfig, vitest config); no cross-package deep imports (scripts/check-cross-package-imports.sh must stay green); bun.lock regenerated (never hand-edited) in the same commit as any package.json dependency change.\n` +
	`- Email/DKIM correctness: header folding never splits a multi-byte UTF-8 sequence or exceeds RFC 2047's 75-octet encoded-word cap; every emitted line <= 998 octets (RFC 5322); DKIM canonicalization fold-stable; key material and credentials never logged.\n`;

const REVIEWER_FOCUS =
	`0) HARD TEST GATE (check FIRST): the piece card names its test surfaces under TESTS. The PR must ADD or EXTEND every named test surface. If any named test file/extension is missing, the verdict is request_changes REGARDLESS of code quality — say exactly which named tests are missing. Tests must be vitest (never bun test), deterministic, and must actually assert the card's claims (a file that exists but asserts nothing meaningful does NOT satisfy the gate).\n\n` +
	`1) SECURITY: this plan rewrites the outbound mail path — the hot spots:\n` +
	`- CRLF/header injection: EVERY parameterized SMTP command (MAIL FROM, RCPT TO, AUTH) and every composed header value must guard CRLF injection BEFORE serialization; attacker-controlled subjects/addresses/filenames/extra headers must not be able to smuggle commands or headers. Look for the guards explicitly.\n` +
	`- TLS fail-closed: requireTls must NEVER fall back to plaintext delivery; a STARTTLS-stripping server fails with tlsCause 'starttls-unavailable'; rejectUnauthorized/minVersion(TLSv1.2 floor)/SNI servername handled correctly; the mail-sync loopback-only plaintext exception preserved EXACTLY (loopback only — no widening).\n` +
	`- AUTH: credentials only after \`secured\` (or loopback), refused BY THE CLIENT before serialization; credentials and DKIM key material never logged, never in error messages.\n` +
	`- DOUBLE DELIVERY (the highest-severity regression class): any path where a post-DATA ambiguous failure (phase data/data-final, no reply) could be classified retryable is a BLOCKING bug. The smtpReplyCodeToErrorCode table stays authoritative for numeric replies.\n` +
	`- TLS-RPT truthfulness: recorded result types feed RFC 8460 reports sent to other mail operators — cleartext success records starttls-not-supported (never success); enforce-mode cert failures reach sts-webpki-invalid.\n` +
	`- DKIM: signatures verified by mailauth (independent implementation) in tests — never self-verified; oversigning + t= behavior preserved.\n` +
	`- Convex (C2): 'use node' correct; env only via lib/env.ts; no secrets in returned values or logs.\n\n` +
	`2) CODE QUALITY: The diff must CONFORM TO THE SHARED PRODUCT BRIEF (locked decisions D1-D8): no 8BITMIME/BDAT/CRAM-MD5, no socket reuse before X1, no PIPELINING before X2, no EAI before X3, no runtime migration flags, no back-compat shims — old paths deleted in the same PR; string-matching on error messages banned in new code. ` +
	`Strict TS (no new \`any\`, respect TS4111-style index-signature access); dead code deleted, not commented out; focused diff (no drive-by refactors outside the piece scope); bun.lock touched only by pieces that sanction it (M1, S1, M2, C1, C2, R1 — and only regenerated, never hand-edited). ` +
	`Commits are small and ATOMIC (package scaffold / logic / cutover / tests / docs separated) with conventional messages, and carry NO AI/Claude attribution of any kind.\n\n` +
	`3) FUNCTIONALITY & TESTS: The piece genuinely delivers its spec and acceptance criteria; nothing that worked before is broken: MTA direct-to-MX sending (MTA-STS enforce/testing, VERP, per-IP EHLO, bounce classification, TLS-RPT recording), API relay sends (EmailErrorCode taxonomy, AMBIGUOUS_TIMEOUT semantics, cached transport in 'use node'), mail-sync external sends (raw .eml bytes, Bcc via RCPT set, verify(), loopback exception), DKIM signing (oversign + t=, mailauth-verified). ` +
	`Where a card says existing suites pass "unchanged"/"rewritten only where they asserted nodemailer internals" — verify the PR does not gut existing assertions to make them pass; the double-delivery decision table (categorizeError) must be provably unchanged case-by-case. ` +
	`GitHub Actions is the source of truth for compile + test: check \`gh pr checks <num> --repo ${REPO}\`. BLOCK on FAILED checks; do NOT block solely because checks are pending/queued.\n\n` +
	`4) CODE SMELLS:\n${SMELLS}\n` +
	`5) BEST PRACTICES:\n${BEST_PRACTICES}`;

// ===========================================================================
// Shared conventions handed to every build / address / resolve agent
// ===========================================================================
const CONV =
	`REPO ROOT: ${ROOT}\n` +
	`This is the public OSS monorepo ${REPO}; remote \`origin\` = github.com:${REPO}. ` +
	`BASE BRANCH FOR THIS PIPELINE: \`${BASE}\` — an integration branch cut from main. Worktrees branch from origin/${BASE}; piece PRs TARGET ${BASE}; the pipeline NEVER merges anything to ${MAIN} (F1 opens the giant ${MAIN} <- ${BASE} PR and a human merges it).\n` +
	`THE MAIN CHECKOUT AT ${ROOT} IS NOT YOURS: it may be on a different branch with uncommitted work. Use it ONLY for \`git -C "${ROOT}" fetch/worktree/branch\` plumbing; never switch its branch, never edit files in it.\n` +
	`Relevant surfaces: apps/mta (Node SMTP MTA — outbound = src/smtp/sender.ts + connectionPool.ts + tlsSecuredCapture.ts + dkim.ts + tlsRpt.ts + mtaSts.ts), apps/api/convex (backend — relay adapter = lib/sendProviders/smtp/index.ts; composer = mail/rfc822.ts + mail/outbound.ts; READ apps/api/convex/CONVENTIONS.md before touching convex files; env ONLY via lib/env.ts), apps/mail-sync (send.ts + tls.ts; IMAP side untouched), packages/ (new: mail-message, smtp-client — mirror packages/shared's package.json/tsconfig/vitest conventions; workspaces glob packages/* picks them up automatically).\n\n` +
	`GOAL OF THIS PIPELINE: land the reviewed 2026-07-11 "Owning the Wire" plan on ${BASE} — the two new packages, three call-site cutovers (mail-sync, API relay, MTA pool + sender), nodemailer excision, the quirk suite + golden corpus, and four capability follow-ups (socket reuse, PIPELINING, SMTPUTF8, XOAUTH2) — WITHOUT losing existing behavior.\n\n` +
	BRIEF +
	`\n\n` +
	`WORKTREE DISCIPLINE: do ALL file changes in a DEDICATED git worktree under ${SCRATCH} created from origin/${BASE}. Use \`git -C "$WT"\` and edit files under "$WT". Pieces run in PARALLEL — never touch another piece's worktree or branch.\n\n` +
	`HARD RULES:\n` +
	`- VERIFICATION IS OFFLOADED TO GITHUB ACTIONS. Do NOT run \`bun run ci:verify\`, a full \`turbo lint/typecheck/test\`, a cold \`npx vitest\`, a \`nuxt build\`, or \`bun install\` + build chains inside the fresh worktree (no node_modules / cold builds exceed the ~180s no-progress watchdog and kill you; the ONE exception is the sanctioned lockfile regeneration below). On push, GitHub Actions runs the full gate — that is the source of truth. Only INSTANT local checks are allowed: targeted \`grep\`/\`rg\`, reading files, a quick JSON/YAML parse, \`node -e\` one-liners. Give every Bash command a \`timeout\`.\n` +
	`- LOCKFILE: pieces M1, S1, M2, C1, C2 and R1 change dependencies / add workspace packages — regenerate bun.lock IN THE SAME COMMIT as the package.json change: \`timeout 420 bun install --lockfile-only\` at the worktree root (if --lockfile-only is unsupported, plain \`timeout 420 bun install\`). This is the ONLY sanctioned install; never hand-edit bun.lock. A stale lockfile is a frozen-lockfile CI insta-fail.\n` +
	`- CI ENFORCES oxfmt FORMATTING. Before you push, format the files you changed: \`oxfmt --config "${ROOT}/oxfmtrc.json" --write <changed .ts/.js files>\` (run on the worktree copies; EXCLUDE any \`_generated/\` paths; NEVER run bare npx oxfmt without --config).\n` +
	`- ENV DISCIPLINE: Convex-side vars only via lib/env.ts (lint:env blocks direct process.env); MTA-side vars via apps/mta/src/config.ts.\n` +
	`- Tests are vitest, never \`bun test\`. THE TEST GATE IS HARD: implement every test surface named on your piece card — the reviewer rejects the PR otherwise. Let CI run them.\n` +
	`- Do NOT weaken existing behavior (see SEMANTICS-PRESERVING in the brief). Keep changes strictly within the piece's file scope.\n` +
	`- Commits: small and ATOMIC (one logical change each — package scaffold separate from logic, cutover separate from tests/docs), conventional messages (feat:/refactor:/fix:/test:/docs:/chore:). ABSOLUTELY NO AI/Claude attribution — no "Co-Authored-By: Claude", no "Generated with", nothing identifying the commit as AI-authored.\n` +
	`- STAY IN SCOPE: work ONLY on this one piece and its branch/worktree. Do NOT read this workflow script, do NOT touch other pieces' branches, do NOT start other pieces.\n` +
	`- KEEP MOMENTUM: ~180-second no-progress watchdog per step. Prefer ripgrep + targeted Reads (offset/limit) over reading whole large files; act incrementally with frequent tool calls. Some source files contain em-dash bytes that make grep treat them as binary — use \`grep -a\` if a text search unexpectedly finds nothing.\n` +
	`- STRICT TypeScript is the #1 CI failure cause — write type-correct code the FIRST time. This repo runs tsconfig strict + noUncheckedIndexedAccess + noPropertyAccessFromIndexSignature. Concretely: (a) index-signature / dynamic-key access MUST use bracket notation and be narrowed — \`obj['key']\` not \`obj.key\` when the type is a Record/index signature (the TS4111 trap); (b) any array/Map/object lookup can be \`undefined\` — guard it before use; (c) NO new \`any\` (use \`unknown\` + narrowing or a real type); (d) remove EVERY unused import/var/param (oxlint fails on these); (e) exhaustive switch/discriminated unions need a default or never-check.\n`;

// ===========================================================================
// LOCAL PREFLIGHT — cheap, watchdog-SAFE checks that catch most CI failures
// WITHOUT a cold build.
// ===========================================================================
const PREFLIGHT =
	`LOCAL PREFLIGHT (run in the worktree BEFORE you push — these are fast and watchdog-safe; give each a \`timeout\`):\n` +
	`1. FORMAT: \`oxfmt --config "${ROOT}/oxfmtrc.json" --write <your changed .ts/.js files>\` (exclude any _generated/ paths). Instant.\n` +
	`2. LINT (catches unused vars/imports, no-explicit-any, and many correctness lints; needs NO types or build): \`oxlint --config "${ROOT}/oxlintrc.json" <changed dirs/files>\`. Read EVERY reported problem and fix it (hand-fix; \`--fix\` only for the safe auto-fixable ones). Re-run until zero errors on your files.\n` +
	`3. FAST REPO LINTS (pure file/grep checks, no build — run only if you touched files they cover): file-size ratchet \`bash "${ROOT}/scripts/check-file-size.sh"\`, branding \`bash "${ROOT}/scripts/check-branding.sh"\`, cross-package imports \`bash "${ROOT}/scripts/check-cross-package-imports.sh"\`, env discipline \`bash "${ROOT}/scripts/check-env-vars.sh" 2>/dev/null || true\`. Fix anything they flag.\n` +
	`4. TYPES — reason, do not cold-build: you CANNOT run \`turbo typecheck\`/\`tsc\` here (needs a warm install; it will exceed the watchdog and kill you). Instead SELF-REVIEW every changed .ts against the STRICT TypeScript rules in HARD RULES above — read your own diff adversarially for undefined-index access, index-signature dot access, unused symbols, and new \`any\`. GitHub Actions runs the real typecheck.\n` +
	`Only push once preflight steps 1-3 are clean and you have self-reviewed types. This turns first-push-red into first-push-green and saves a whole CI+fix round.\n`;

// ===========================================================================
// PIECES — one atomic PR each. Specs come from the reviewed 2026-07-11 plan
// (nodemailer-removal-plan.html §05); `focus` is the card's reviewer-focus
// line; `optional` = X pieces (permanent failure drops the capability);
// `humanMerge` = F1 (pipeline stops at approved+green).
// ===========================================================================
const PIECES = [
	// ---- Wave 1: foundations (no product behavior change) ---------------------
	{
		id: 'M1',
		kind: 'refactor',
		dependsOn: [],
		branch: 'otw/m1-mail-message',
		title: 'refactor(api): extract the RFC 5322 composer into packages/mail-message',
		spec:
			"Create the new workspace package packages/mail-message (mirror packages/shared for package.json name/exports/tsconfig/vitest conventions; ZERO runtime deps beyond node:crypto — it must stay Convex-'use node'-compatible). Move the pure helpers out of apps/api/convex/mail/rfc822.ts — encodeHeaderValue, encodeAddressHeader, quotedPrintableEncode, encodeTextBody, escapeHeader, safeAttachmentFilename, buildMessageId, randomBoundary, buildRfc822, stripHtml — into the package (src/headers.ts, src/encoding.ts, src/messageId.ts, src/compose.ts per the plan layout). Decouple buildRfc822 from the Convex DraftRow type: it takes a neutral ComposeInput; a thin adapter left in apps/api/convex/mail/rfc822.ts maps DraftRow -> ComposeInput and re-exports, so NO Convex call site changes in this PR. Attachment content becomes Buffer | base64 string at the package boundary (storage fetching stays in outbound.ts). Regenerate bun.lock in the same commit as the new package (sanctioned). Flag (comment in the PR body, do NOT migrate) the MTA's duplicated buildMessageId/stripHtml in apps/mta/src/smtp/sender.ts — that is C4's job. " +
			'Also commit this pipeline\'s harness into the repo as its own chore commit: copy "' +
			ROOT +
			'/.claude/workflows/nodemailer-removal-prs.js" from the MAIN CHECKOUT (read-only copy — do not edit the main checkout) into the worktree at .claude/workflows/nodemailer-removal-prs.js.',
		tests:
			"NAMED TEST GATE: (a) ALL existing rfc822 tests (apps/api/convex/mail/__tests__/*) pass — tests move with the code into packages/mail-message/__tests__/ where they test moved helpers; whatever remains against the adapter keeps the old import path alive and passes UNCHANGED in assertions; (b) a package-level test proves the package imports cleanly with zero non-node:crypto deps (no 'use node'-incompatible imports).",
	},
	{
		id: 'S1',
		kind: 'feat',
		dependsOn: [],
		branch: 'otw/s1-smtp-client-scaffold',
		title:
			'feat: scaffold packages/smtp-client — reply parser, SmtpError, dot-stuffing, command serializers (no sockets)',
		spec: 'Create the new workspace package packages/smtp-client (node-only; mirror packages/shared conventions; regenerate bun.lock in the same commit — sanctioned). The pure, exhaustively-testable core, NO sockets in this piece: src/reply.ts — a reply parser handling multiline 250-…/250 … continuation, RFC 3463 X.Y.Z enhanced-code extraction, tolerant of lowercase/whitespace-sloppy servers; src/errors.ts — the SmtpError type with the phase/tlsCause discriminants from the brief; src/dotStuff.ts — a streaming dot-stuffing encoder (\\r\\n. -> \\r\\n.., bare-LF normalization, terminal \\r\\n.\\r\\n); src/commands.ts — command serializers with CRLF-injection guards on every parameterized field; an EHLO capability-table parser (SIZE, STARTTLS, AUTH mechanisms).',
		tests:
			'NAMED TEST GATE: (a) packages/smtp-client/__tests__/dotStuff.test.ts — property-style: dot-stuffing round-trips against a reference decoder for adversarial inputs (lone "." lines, CR-only, LF-only, 5MB bodies); (b) __tests__/reply.test.ts — table tests over REAL checked-in transcript fixtures (Gmail, Outlook, Postfix, Exim greetings + multiline EHLO responses); (c) __tests__/commands.test.ts — CRLF injection in MAIL FROM / RCPT TO parameters THROWS before anything is serialized; (d) EHLO capability-table parser tests.',
	},

	// ---- Wave 2: the two engines ----------------------------------------------
	{
		id: 'M2',
		kind: 'feat',
		dependsOn: ['M1'],
		branch: 'otw/m2-compose-message',
		title:
			'feat(mail-message): composeMessage() — full nodemailer-composer parity, proven differentially',
		spec: "Generalize buildRfc822 into composeMessage(input) in packages/mail-message/src/compose.ts covering everything the MTA and API paths feed nodemailer today: from/replyTo/to/cc/bcc (display-name address formatting), subject, html + text (with stripHtml fallback), AMP as a text/x-amp-html alternative ordered BEFORE html (plain -> amp -> html, matching nodemailer's part order), attachments (Buffer content, contentType, inline CID), arbitrary extra headers with injection stripping, explicit-or-generated Message-ID, and a returned envelope. Deterministic given seeded boundary/date inputs — this is what makes DKIM-stable retries and golden tests possible. THE DIFFERENTIAL HARNESS IS THE HEART OF THIS PIECE: add nodemailer + @types/nodemailer + mailparser as devDependencies of packages/mail-message ONLY (regenerate bun.lock — sanctioned); for a corpus of ~40 structured inputs (unicode subjects at fold boundaries, long address lists, AMP + attachments + inline images together, empty text, 998-octet lines), compose with both nodemailer's MailComposer and ours, parse both with mailparser, and assert SEMANTIC equality: same part tree, same decoded bodies, same effective header values. Byte equality is NOT required; parsed equality is.",
		tests:
			'NAMED TEST GATE: (a) packages/mail-message/__tests__/compose.differential.test.ts — differential suite green across the ~40-input corpus, corpus reviewable as __tests__/fixtures/*.eml or structured fixture files; (b) a lint-style test asserting EVERY emitted line <= 998 octets (RFC 5322 hard cap) over all fixture outputs; (c) a determinism test: output byte-identical across two calls with identical seeds (the determinism gate for M3).',
		focus:
			'Header folding at encoded-word boundaries; RFC 2047 75-octet cap including delimiters; an encoded-word must never split a multi-byte UTF-8 sequence.',
	},
	{
		id: 'S2',
		kind: 'feat',
		dependsOn: ['S1'],
		branch: 'otw/s2-connection-engine',
		title: 'feat(smtp-client): connection engine — sockets, STARTTLS, and the secured flag',
		spec: 'packages/smtp-client/src/connection.ts — the socket layer: TCP connect with localAddress binding, implicit-TLS or cleartext-then-STARTTLS, greeting wait, EHLO (HELO fallback), STARTTLS upgrade honoring requireTls / rejectUnauthorized / minVersion (TLSv1.2 floor default) / servername SNI, re-EHLO after upgrade, per-phase timeouts (connect, greeting, command, data), and first-class \`secured\` + negotiated-protocol metadata. TLS failures classified AT THE SOURCE into tlsCause from the actual Node error codes (CERT_HAS_EXPIRED, ERR_TLS_CERT_ALTNAME_INVALID, …) — never from message strings.',
		tests:
			"NAMED TEST GATE: (a) packages/smtp-client/__tests__/connection.integration.test.ts against in-process smtp-server (already a repo dep): implicit TLS, STARTTLS, and a STARTTLS-stripping server + requireTls -> fails closed with tlsCause 'starttls-unavailable'; (b) raw net-server edge tests: multiline greeting, greeting timeout, mid-handshake disconnect, self-signed / hostname-mismatch / expired certs each yield their EXACT tlsCause (there is an existing cert fixture helper at apps/mta/src/smtp/__tests__/certFixture.ts to learn from); (c) \`secured\` is true iff the socket is TLS at EHLO-completion time — asserted in both upgrade and cleartext paths.",
	},

	// ---- Wave 3: signing & transactions ----------------------------------------
	{
		id: 'M3',
		kind: 'feat',
		dependsOn: ['M2'],
		branch: 'otw/m3-dkim-over-bytes',
		title:
			'feat(mail-message): DKIM over bytes — port the hardened signer to signMessage(raw, key)',
		spec: "Port the MTA's hardened signer (apps/mta/src/smtp/dkim.ts) — oversigned From/Subject/To, t= timestamp, relaxed/relaxed, the extended header field list — from a nodemailer processFunc stream transform to packages/mail-message/src/dkim.ts: signMessage(raw: Buffer, key) -> Buffer that PREPENDS the DKIM-Signature to bytes composeMessage produced. Signing our own deterministic output removes the stream-plumbing and the CRLF/LF boundary defensiveness the current signer needs. apps/mta/src/smtp/dkim.ts stays UNTOUCHED in this PR (C3/C4 cut it over). mailauth may be added as a devDependency of mail-message for verification tests if not already reachable.",
		tests:
			'NAMED TEST GATE: (a) packages/mail-message/__tests__/dkim.test.ts — EVERY signature in the test corpus verifies with mailauth (independent implementation — the anti-self-delusion gate); (b) oversigning + t= behavior matches the current signer bit-for-bit on shared fixtures (port the existing dkimSign e2e fixtures); (c) signature survives a compose -> sign -> parse-with-mailparser -> reserialize round trip (canonicalization is fold-stable).',
	},
	{
		id: 'S3',
		kind: 'feat',
		dependsOn: ['S2'],
		branch: 'otw/s3-transaction-layer',
		title: 'feat(smtp-client): transaction layer — AUTH, envelope, DATA, verify(), sendMessage()',
		spec: "packages/smtp-client/src/transaction.ts + index.ts: AUTH PLAIN and LOGIN (ONLY after \`secured\` unless loopback — encode the mail-sync invariant in the client itself, refusing BEFORE credentials are serialized); MAIL FROM with SIZE when advertised; RCPT TO collecting PER-RECIPIENT verdicts (proceed if >=1 accepted, report the rest with their reply codes); DATA via the S1 dot-stuffer; QUIT/destroy teardown; a verify() (connect -> EHLO -> AUTH -> QUIT) for connection testing; and the one-shot sendMessage(opts) convenience wrapper. Every failure carries its phase — the property C2's retry taxonomy is rebuilt on.",
		tests:
			"NAMED TEST GATE: packages/smtp-client/__tests__/transaction.integration.test.ts — (a) successful send against in-process smtp-server with auth; message received byte-identical after un-dot-stuffing; (b) partial RCPT acceptance (2 of 3 recipients) -> send proceeds, verdicts correct per recipient; (c) server drops mid-DATA vs rejects at MAIL: distinguishable by phase ('data'/'data-final' are the double-delivery-ambiguous phases; earlier phases are safely retryable); (d) AUTH refused on an unsecured non-loopback connection BY THE CLIENT, before credentials are serialized.",
	},

	// ---- Wave 4: first cutovers (different apps, zero shared files) -------------
	{
		id: 'C1',
		kind: 'refactor',
		dependsOn: ['S3'],
		branch: 'otw/c1-mail-sync-cutover',
		title: 'refactor(mail-sync): cut over to smtp-client (pilot: protocol only, no composer)',
		spec: "The lowest-risk cutover proves the client first: apps/mail-sync/src/send.ts sendViaExternal already ships raw .eml bytes, so this swaps ONLY the transport (custom envelope, Bcc via RCPT set preserved). apps/mail-sync/src/tls.ts smtpTlsOptions maps onto client options — loopback-only plaintext exception (Proton Bridge) preserved EXACTLY; requireTls + TLSv1.2 floor for everything else. Per-recipient RCPT verdicts replace the info.rejected inference. testSmtp uses the client's verify(). IMAP side untouched. nodemailer removed from apps/mail-sync/package.json in this PR (regenerate bun.lock — sanctioned); the old nodemailer path DELETED, no shim.",
		tests:
			'NAMED TEST GATE: (a) existing apps/mail-sync/src/__tests__/send.test.ts, tls.test.ts, connection.tls.test.ts suites pass, rewritten ONLY where they asserted nodemailer internals (the reviewer checks assertions were not gutted); (b) Bcc semantics: the RCPT set is exactly params.recipients, independent of visible headers (existing test preserved); (c) grep proves nodemailer gone from apps/mail-sync/package.json and imports.',
	},
	{
		id: 'C2',
		kind: 'refactor',
		dependsOn: ['M2', 'S3'],
		branch: 'otw/c2-api-relay-cutover',
		title:
			'refactor(api): cut over the relay adapter — composer + client + error taxonomy on structured phases',
		spec: "apps/api/convex/lib/sendProviders/smtp/index.ts: sendEmail becomes composeMessage -> sendMessage with the cached-client-config pattern intact (lazy from SMTP_RELAY_* via lib/env.ts). THE CRITICAL WORK is rebuilding classifySmtpError on structured input: phase in {connect, greeting, ehlo, starttls, auth} -> retryable SERVER_ERROR/AUTH_FAILED (nothing reached the wire); phase in {data, data-final} with no reply -> AMBIGUOUS_TIMEOUT (the 250 may be lost — NEVER auto-retry); a numeric reply code stays authoritative via the existing smtpReplyCodeToErrorCode table, which survives UNCHANGED. The outer withTimeout ambiguity rule and SMTP_CONNECTION_TIMEOUT_MS pre-acceptance bound keep their exact semantics. String-matching helpers (isTimeoutError, isConnectionLoss) DELETED, not adapted. Runs under 'use node'; bun run lint:env clean; nodemailer removed from apps/api/package.json (regenerate bun.lock — sanctioned). Read apps/api/convex/CONVENTIONS.md before touching convex files.",
		tests:
			'NAMED TEST GATE: (a) apps/api/convex/lib/sendProviders/smtp/__tests__/categorizeError.test.ts — EVERY case in the existing table-driven tests has a successor asserting the SAME EmailErrorCode from structured input; the double-delivery decision table must be provably unchanged case-by-case (the reviewer diffs old cases vs new); (b) adapter-level test that requireTLS semantics are preserved fail-closed; (c) grep proves isTimeoutError/isConnectionLoss and all nodemailer imports gone from apps/api.',
		focus:
			'Any path where a retryable classification could now reach a post-DATA failure = double-delivery bug. Treat as blocking.',
	},

	// ---- Wave 5: the MTA (serial: C4 builds on C3's pool) ------------------------
	{
		id: 'C3',
		kind: 'refactor',
		dependsOn: ['S3', 'M3'],
		branch: 'otw/c3-mta-pool',
		title:
			'refactor(mta): connection pool on smtp-client (keying, Redis cap, gauges preserved; DKIM plugin removed)',
		spec: "apps/mta/src/smtp/connectionPool.ts keeps its EXACT shape — key {mx, bindIp, dkimDomain, tlsProfile}, per-host LRU eviction, idle/age eviction, Redis global slot INCR/DECR with fail-open, Prometheus gauge — but entries hold smtp-client configs instead of nodemailer transports (one-connection-per-send preserved per locked decision D3; live-socket reuse is X1, NOT this piece). The use('stream') DKIM plugin wiring is DELETED: signing moves to compose time (C4), so the pool stops knowing about message transformation entirely. dkimDomain stays in the key purely as a partitioning dimension.",
		tests:
			'NAMED TEST GATE: (a) apps/mta/src/smtp/__tests__/connectionPool.test.ts — all pool tests pass with test doubles targeting the new client interface; the TLS-profile keying test (enforce vs opportunistic NEVER share an entry) preserved verbatim; (b) global-cap reserve/release accounting identical: reuse takes no slot, every teardown path releases.',
	},
	{
		id: 'C4',
		kind: 'refactor',
		dependsOn: ['C3', 'M2', 'M3'],
		branch: 'otw/c4-mta-sender',
		title:
			'refactor(mta): sender — compose-once + sign-once, structured TLS results, delete tlsSecuredCapture',
		spec: "THE CENTERPIECE. apps/mta/src/smtp/sender.ts sendToMx composes ONCE per job — composeMessage (html/text/AMP/attachments/headers, From-aligned Message-ID, VERP envelope) then signMessage — and retries the SAME signed bytes across MX hosts and TLS profiles (today nodemailer recomposes per attempt; identical bytes across retries is a strict improvement). attemptSend reads client.secured directly for TLS-RPT result recording — apps/mta/src/smtp/tlsSecuredCapture.ts is DELETED, along with its logger threading through the pool. classifyTlsFailure becomes a thin map from SmtpError.tlsCause to TlsResultType; the string-matching table goes. apps/mta/src/smtp/dkim.ts slims to key management (signing now lives in mail-message). The MTA's duplicated buildMessageId/stripHtml migrate to mail-message imports. Everything RFC-semantic is preserved UNCHANGED: MTA-STS enforce MX filtering + testing-mode probe-then-opportunistic-retry, stsAttributedResultType escalation, 4xx/5xx/5.2.2 bounce classification, per-IP EHLO names. Remove deleted files from coverage config if referenced.",
		tests:
			'NAMED TEST GATE: (a) all 7 touched apps/mta/src/smtp/__tests__ suites green; the STARTTLS-stripping, cert-mismatch, and plaintext-delivery TLS-RPT scenarios (existing integration tests) assert IDENTICAL recorded result types; (b) NEW test: composed+signed bytes byte-identical across MX retries of one job; (c) DKIM on the wire verifies with mailauth in the e2e signing test (port of dkimSign.e2e.test.ts); (d) grep -ri nodemailer apps/mta/src -> only historical comments, no imports.',
		focus:
			'TLS-RPT truthfulness: cleartext success must still record starttls-not-supported (not success); enforce-mode cert failures must still reach sts-webpki-invalid. These feed reports we send to other mail operators.',
	},

	// ---- Wave 6: removal & the regression net ------------------------------------
	{
		id: 'R1',
		kind: 'chore',
		dependsOn: ['C1', 'C2', 'C4'],
		branch: 'otw/r1-excise-nodemailer',
		title: 'chore: excise nodemailer — last package.json, lockfile, stale comments, docs',
		spec: "Remove nodemailer + @types/nodemailer from the last package.json (apps/mta — M2's differential tests keep nodemailer as a devDependency of packages/mail-message ONLY), regenerate bun.lock (sanctioned), sweep the ~40 comment references across ~12 files that describe nodemailer behavior no longer present (convexRuntimeEnv.ts, externalAccountsActions.ts port-semantics note, mtaSts.ts, types.ts — grep -ri nodemailer to find them all), update docs that name the dependency. Run the knip ratchet config check if one exists to confirm nothing dangling.",
		tests:
			"NAMED TEST GATE: (a) grep -ri nodemailer across apps/ -> ZERO hits; the sole remaining reference in packages/ is mail-message's differential-test devDependency; (b) CI green on the PR (its frozen-lockfile install is the fresh-install proof).",
	},
	{
		id: 'R2',
		kind: 'test',
		dependsOn: ['C4'],
		branch: 'otw/r2-quirks-goldens',
		title: 'test: long-tail quirk suite + golden .eml corpus with mailauth re-verification in CI',
		spec: "The insurance policy against what nodemailer's 15 years bought. (1) packages/smtp-client/__tests__/quirks.integration.test.ts — raw-socket fake servers reproducing real-world misbehavior: reply lines split across TCP packets, multiline replies with inconsistent codes, servers sending the greeting in two writes, early 421 mid-transaction, 4xx to STARTTLS, timeout-then-banner, 8-bit garbage in replies, CRLF-less final responses. Each quirk is a NAMED test with a comment citing where the behavior was observed. (2) GOLDEN CORPUS: checked-in .eml outputs at packages/mail-message/__tests__/golden/*.eml for the M2 fixture inputs, diffed BYTE-FOR-BYTE in CI so any composer change is a visible, reviewed diff — and every golden file's DKIM signature re-verified with mailauth on every run. Regenerating goldens requires a dedicated script (bun run goldens:update in the package's package.json) so it can't happen silently. Wire the golden-diff into the package's test run (which ci:test executes).",
		tests:
			'NAMED TEST GATE: (a) quirks.integration.test.ts with every quirk listed above, named + provenance comment; (b) golden corpus checked in + byte-diff test + mailauth DKIM re-verification test; (c) goldens:update script exists and is documented in the package README.',
	},

	// ---- Wave 7: capability follow-ups (serial — all extend smtp-client) ---------
	{
		id: 'X1',
		kind: 'feat',
		optional: true,
		dependsOn: ['R1', 'R2'],
		branch: 'otw/x1-socket-reuse',
		title: 'feat: true socket reuse — RSET-based multi-message connections in the MTA pool',
		spec: 'What the "pool" name always promised: pool entries hold LIVE connected clients, and consecutive jobs to the same {mx, bindIp, dkimDomain, tlsProfile} reuse the socket via RSET between transactions instead of paying TCP + TLS + EHLO per message (packages/smtp-client/src/transaction.ts grows RSET-boundary multi-transaction support; apps/mta/src/smtp/connectionPool.ts + sender.ts adopt it). Guardrails: max-messages-per-connection cap (default ~100), max connection lifetime honoring today\'s maxAgeMs, unhealthy-connection detection (ANY transport error tears down the entry — never retry on a poisoned socket), and the Redis global cap now counts live sockets. Prometheus gauge gains a reused_total counter so the win is measurable.',
		tests:
			'NAMED TEST GATE: (a) integration: N sequential sends to one fake MX use ONE connection with RSET boundaries; message N+cap triggers a clean QUIT + reconnect; (b) a 421 or socket death mid-stream evicts the entry, releases the Redis slot, and the in-flight job retries on a fresh connection exactly once; (c) secured + TLS-RPT recording remain per-CONNECTION, correctly attributed to every message sent over it; (d) reused_total counter test.',
		focus:
			'State leakage between transactions on a reused socket (leftover replies, half-read multiline responses) — the classic reuse bug class.',
	},
	{
		id: 'X2',
		kind: 'feat',
		optional: true,
		dependsOn: ['X1'],
		branch: 'otw/x2-pipelining',
		title: 'feat(smtp-client): PIPELINING (RFC 2920) — batch envelope commands when advertised',
		spec: 'When EHLO advertises PIPELINING, send MAIL FROM + all RCPT TOs + DATA in one write and read the replies as a batch — cutting a multi-recipient envelope from 2+N round trips to 2. STRICTLY capability-gated: servers not advertising it get the v1 sequential path unchanged. Per-recipient verdicts and the phase-based error taxonomy must be INDISTINGUISHABLE from sequential mode — pipelining changes timing, never semantics.',
		tests:
			"NAMED TEST GATE: packages/smtp-client/__tests__/pipelining.integration.test.ts — (a) batched replies correctly matched to their commands, including mixed accept/reject RCPT sets and a rejected MAIL FROM aborting the batch; (b) quirk tests: a server that advertises PIPELINING but replies one-packet-per-line, and replies split mid-batch across TCP segments; (c) C2's classification tests pass identically with pipelining forced on and forced off (same taxonomy, both paths).",
	},
	{
		id: 'X3',
		kind: 'feat',
		optional: true,
		dependsOn: ['X2'],
		branch: 'otw/x3-smtputf8',
		title:
			'feat: SMTPUTF8 / EAI (RFC 6531-6532) — internationalized addresses end-to-end, fail-closed downgrade',
		spec: "Accept UTF-8 localparts (anna@bücher.example, 世界@example.jp) through composer and client. Composer (packages/mail-message): UTF-8 headers emitted natively when the message is flagged EAI (encoded-words remain for the non-EAI path); domains still IDN-normalized. Client (packages/smtp-client): request SMTPUTF8 on MAIL FROM when the server advertises it; when it doesn't, FAIL CLOSED with a precise, user-visible error — a UTF-8 localpart cannot be downgraded (there is no punycode for localparts), and silently mangling an address is worse than declining. Contact import/validation surfaces stop rejecting these addresses at the door (find them by grepping address-validation call sites).",
		tests:
			"NAMED TEST GATE: (a) round trip: compose EAI message -> parse with mailparser -> addresses and headers survive byte-exact; DKIM verifies with mailauth; (b) non-advertising server -> send fails at phase 'mail' with a distinct EmailErrorCode mapped to a clear message, recorded as a hard (non-retryable) failure; (c) ASCII-only mail is byte-identical to pre-X3 output — the R2 golden corpus passes UNCHANGED (the EAI path is strictly additive).",
	},
	{
		id: 'X4',
		kind: 'feat',
		optional: true,
		dependsOn: ['X3'],
		branch: 'otw/x4-xoauth2',
		title: 'feat: AUTH XOAUTH2 — token-based auth for external Gmail / Microsoft accounts',
		spec: 'The SASL XOAUTH2 mechanism (user=…\\x01auth=Bearer …\\x01\\x01) as a third auth option in packages/smtp-client, with the 334 challenge-response error shape decoded into a structured auth-phase failure (expired token vs bad credentials are DISTINGUISHABLE — the caller needs to know which means "refresh" and which means "reconnect account"). apps/mail-sync/src/send.ts grows the option plumbing. Token acquisition/refresh and the IMAP side are the external-accounts OAuth feature\'s scope, NOT this piece\'s. Like all AUTH: refused on unsecured non-loopback connections before anything is serialized.',
		tests:
			'NAMED TEST GATE: (a) fake server validating the EXACT XOAUTH2 initial-response encoding; success and both failure shapes covered; (b) expired-token 334 response surfaces a distinct retryable-after-refresh error; malformed-credential rejection surfaces as terminal AUTH_FAILED; (c) PLAIN/LOGIN paths byte-identical to pre-X4 behavior (existing transaction tests pass unchanged).',
	},

	// ---- Wave 8: the giant PR (base: main; HUMAN-merged) --------------------------
	{
		id: 'F1',
		kind: 'chore',
		dependsOn: ['R1', 'R2'],
		branch: BASE, // the PR head IS the integration branch
		base: MAIN,
		humanMerge: true,
		title:
			'Integration PR: main <- integration/own-the-wire (Owning the Wire — nodemailer removal)',
		spec: 'no new code — final main-sync merge, audit, narrative PR body; see the dedicated F1 steps in the build prompt.',
		tests:
			'GATE: GitHub CI green on the PR head after the final main-sync merge (full suite, all packages, incl. the R2 golden corpus + mailauth DKIM verification on the exact merged tree); grep -ri nodemailer apps/ on the PR head -> zero hits; no TODO(own-the-wire) markers remain.',
	},
];

const WAVES = [
	[['M1'], ['S1']],
	[['M2'], ['S2']],
	[['M3'], ['S3']],
	[['C1'], ['C2']],
	[['C3', 'C4']],
	[['R1'], ['R2']],
	[['X1', 'X2', 'X3', 'X4']],
	[['F1']],
];

// ===========================================================================
// Structured-output schemas
// ===========================================================================
const BUILD_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: ['opened', 'reused', 'prNumber', 'prUrl', 'branch', 'commits', 'summary'],
	properties: {
		opened: { type: 'boolean' },
		reused: { type: 'boolean' },
		alreadyLanded: { type: 'boolean' },
		prNumber: { type: 'integer' },
		prUrl: { type: 'string' },
		branch: { type: 'string' },
		commits: { type: 'array', items: { type: 'string' } },
		testsAdded: { type: 'array', items: { type: 'string' } },
		blockReason: { type: 'string' },
		summary: { type: 'string' },
	},
};
const CI_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: ['state', 'failing', 'summary'],
	properties: {
		state: { type: 'string', enum: ['pass', 'fail', 'pending', 'unknown'] },
		failing: { type: 'array', items: { type: 'string' } },
		summary: { type: 'string' },
	},
};
const PR_STATE_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: ['lastIsUnaddressedReview', 'summary'],
	properties: {
		lastIsUnaddressedReview: { type: 'boolean' },
		openConcerns: { type: 'array', items: { type: 'string' } },
		summary: { type: 'string' },
	},
};
const REVIEW_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: ['verdict', 'commentPosted', 'blockingFindings', 'improvements', 'summary'],
	properties: {
		verdict: { type: 'string', enum: ['approve', 'request_changes'] },
		commentPosted: { type: 'boolean' },
		blockingFindings: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				required: ['file', 'issue'],
				properties: {
					file: { type: 'string' },
					line: { type: 'integer' },
					issue: { type: 'string' },
				},
			},
		},
		improvements: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				required: ['file', 'issue'],
				properties: {
					file: { type: 'string' },
					line: { type: 'integer' },
					issue: { type: 'string' },
				},
			},
		},
		summary: { type: 'string' },
	},
};
const ADDRESS_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: ['commits', 'pushed', 'resolved', 'unresolved', 'summary'],
	properties: {
		commits: { type: 'array', items: { type: 'string' } },
		pushed: { type: 'boolean' },
		resolved: { type: 'array', items: { type: 'string' } },
		unresolved: { type: 'array', items: { type: 'string' } },
		summary: { type: 'string' },
	},
};
const MERGE_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: ['merged', 'prUrl', 'outstanding', 'summary'],
	properties: {
		merged: { type: 'boolean' },
		mergeCommit: { type: 'string' },
		prUrl: { type: 'string' },
		conflict: { type: 'boolean' },
		conflictFiles: { type: 'array', items: { type: 'string' } },
		outstanding: { type: 'array', items: { type: 'string' } },
		summary: { type: 'string' },
	},
};
const RESOLVE_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: ['resolved', 'pushed', 'files', 'summary'],
	properties: {
		resolved: { type: 'boolean' },
		pushed: { type: 'boolean' },
		files: { type: 'array', items: { type: 'string' } },
		blockReason: { type: 'string' },
		summary: { type: 'string' },
	},
};
const SYNC_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: ['merged', 'pushed', 'conflicts', 'summary'],
	properties: {
		merged: { type: 'boolean' },
		pushed: { type: 'boolean' },
		conflicts: { type: 'array', items: { type: 'string' } },
		blockReason: { type: 'string' },
		summary: { type: 'string' },
	},
};

// ===========================================================================
// Prompt builders
// ===========================================================================
function wtPath(p) {
	return `${SCRATCH}/${p.id}`;
}

function f1BuildPrompt(p, droppedCapabilities) {
	const WT = wtPath(p);
	const dropped = droppedCapabilities.length
		? `DROPPED CAPABILITIES (optional X pieces that did not merge this run — state this honestly in the PR body): ${droppedCapabilities.join(', ')}. Their specs remain future post-merge PRs; nothing else was dropped.\n`
		: `All four capability pieces (X1-X4) merged — no capabilities were dropped.\n`;
	return (
		`You are the BUILDER thread for F1 — the GIANT integration PR ${MAIN} <- ${BASE} on ${REPO}. There is NO new code in this piece: your job is the final freshness sync, a full audit, and a PR narrative that makes a 15-PR-sized diff reviewable. THE PIPELINE DOES NOT MERGE THIS PR — Marcel reviews and squash-merges it by hand.\n\n` +
		CONV +
		`\n${dropped}\n` +
		`STEP 0 — REUSE CHECK: \`gh pr list --repo ${REPO} --head ${BASE} --base ${MAIN} --state open --json number,url\`. If the giant PR already exists, adopt it (opened=true, reused=true) and skip to STEP 3 (refresh the body if stale).\n\n` +
		`STEP 1 — FINAL MAIN SYNC: in a worktree (\`git -C "${ROOT}" fetch origin\`; \`git -C "${ROOT}" worktree remove --force "${WT}" 2>/dev/null || true\`; \`git -C "${ROOT}" worktree add --force "${WT}" origin/${BASE}\`), merge origin/${MAIN} into it one final time (trunk wins on conflicts: main's version is the base structure, re-express the own-the-wire change on top — never silently drop an own-the-wire behavior; if bun.lock conflicts, take ${BASE}'s side then regenerate with \`timeout 420 bun install --lockfile-only\`). Push to ${BASE}. If rev-list shows nothing to merge, skip.\n\n` +
		`STEP 2 — AUDIT on the synced head: (a) \`grep -ri nodemailer "${WT}/apps" \` -> must be ZERO hits (historical comments were swept by R1; if any import remains, STOP and return opened=false with blockReason); (b) \`grep -rn "TODO(own-the-wire)" "${WT}"\` -> zero; (c) \`gh pr list --repo ${REPO} --base ${BASE} --state merged --json number,title\` -> every merged piece PR (M1..X4) accounted for.\n\n` +
		`STEP 3 — OPEN THE PR: \`gh pr create --repo ${REPO} --base ${MAIN} --head ${BASE} --title "Owning the Wire: replace nodemailer with in-house mail-message + smtp-client" --body <narrative>\`. The body MUST contain: (1) the two-jobs framing (nodemailer did SMTP wire + MIME composition; both replaced by packages we control; what got DELETED: tlsSecuredCapture.ts, classifyTlsFailure string tables, isTimeoutError/isConnectionLoss, DKIM stream plumbing); (2) a piece-by-piece table linking EVERY constituent integration-branch PR and its review thread, one line each with the reviewer verdict; (3) the payoff table (deleted artifacts -> replacements; -1 runtime dependency, +2 workspace packages); (4) the risk checklist with each mitigation's status (differential corpus, mailauth verification, golden diffs, quirk suite, double-delivery taxonomy pinned, TLS-RPT parity tests); (5) the post-merge watch plan (MTA soft-bounce + connection-failure Prometheus rates for a week, plus the reused_total gauge if X1 landed); (6) the dropped-capabilities note above, honestly; (7) a final line: "Human-merged by design: every constituent piece was agent-reviewed and CI-verified individually; this sign-off flips the entire outbound mail path. Squash-merge so main carries one revertable commit."\n\n` +
		`STEP 4 — clean up the worktree. NO AI attribution anywhere. Return the structured result (opened, prNumber, prUrl, branch=${BASE}).`
	);
}

function buildPrompt(p, droppedCapabilities) {
	if (p.humanMerge) return f1BuildPrompt(p, droppedCapabilities || []);
	const WT = wtPath(p);
	return (
		`You are the BUILDER thread for ONE own-the-wire piece. Implement it end-to-end IN A DEDICATED GIT WORKTREE with ATOMIC commits and open a PULL REQUEST against \`${BASE}\` (the integration branch — NOT ${MAIN}) on ${REPO}.\n\n` +
		CONV +
		`\n` +
		`PIECE: ${p.id} — ${p.title}\nKIND: ${p.kind}\nBRANCH: ${p.branch}\nWORKTREE: ${WT}\n\n` +
		`STEP 0 — REUSE CHECK: run \`gh pr list --repo ${REPO} --head ${p.branch} --state open --json number,url,baseRefName\`. If an open PR already exists for this branch (base ${BASE}), DO NOT rebuild — return it with opened=true, reused=true, its number/url, and stop. ` +
		`Also check \`gh pr list --repo ${REPO} --head ${p.branch} --state merged --json number,url\` and spot-check whether the spec's key deliverables already exist on origin/${BASE} — a previous run may have merged this piece already. If the work has ALREADY LANDED on ${BASE}, do NOT rebuild and do NOT open an empty-diff PR: return alreadyLanded=true, opened=false, prNumber=<the merged PR number or 0>, with a one-line summary. Otherwise continue.\n\n` +
		`SPEC:\n${p.spec}\n\n` +
		`TESTS (HARD GATE — the reviewer rejects the PR if any named test surface is missing):\n${p.tests}\n\n` +
		`STEPS:\n` +
		`1. Sync + make a CLEAN worktree (never touch the main checkout):\n` +
		`   \`git -C "${ROOT}" fetch origin\`\n` +
		`   \`git -C "${ROOT}" worktree remove --force "${WT}" 2>/dev/null || true\`\n` +
		`   \`git -C "${ROOT}" branch -D ${p.branch} 2>/dev/null || true\`\n` +
		`   \`git -C "${ROOT}" worktree add -B ${p.branch} "${WT}" origin/${BASE}\`\n` +
		`   Then do ALL edits under "${WT}" and ALL git ops with \`git -C "${WT}" …\`.\n` +
		`2. Read the ACTUAL current code first (spec file/line notes may have drifted — earlier pieces in this pipeline have already merged into ${BASE}; build on what is actually there). Then implement per the brief. ATOMIC commits (package scaffold / logic / cutover / tests / docs separate). NO AI attribution.\n` +
		`3. PREFLIGHT — run the local checks below and FIX everything they flag before pushing:\n${PREFLIGHT}` +
		`4. \`git -C "${WT}" push -u origin ${p.branch}\`.\n` +
		`5. Open the PR: \`gh pr create --repo ${REPO} --base ${BASE} --head ${p.branch} --title "<title>" --body "<body>"\`. Body: what changed and why (reference the shared product brief and the locked decision(s) this piece implements), the piece's acceptance criteria as a checklist with honest check states, the NAMED TESTS and where each landed, an inventory of preserved behavior, and a final line: "Own-the-wire pipeline: squash-merges into ${BASE} on reviewer approval + green CI; ${BASE} -> ${MAIN} ships later as one human-merged PR (F1)." Capture the PR number + URL.\n` +
		`6. Clean up the worktree (leave the branch pushed): \`git -C "${ROOT}" worktree remove --force "${WT}" 2>/dev/null || true\`.\n\n` +
		`GitHub Actions will verify the push — you do not wait for it. If you truly cannot complete the piece, still push what is coherent and open the PR as a draft (\`--draft\`) with blockReason in the body and opened=true, OR — if nothing shippable exists — set opened=false with blockReason. Return the structured result.`
	);
}

function prStatePrompt(pr) {
	return (
		`Read-only check on PR #${pr} on ${REPO}: is the LAST substantive activity an unaddressed reviewer verdict?\n` +
		`Run \`gh pr view ${pr} --repo ${REPO} --json comments,commits\` and inspect chronology. The pipeline's reviewer posts comments containing "**Verdict: REQUEST_CHANGES**" or "**Verdict: APPROVE**"; the author replies with "## Author response" comments and/or new commits.\n` +
		`Set lastIsUnaddressedReview=true IFF the newest verdict comment says REQUEST_CHANGES AND there is NO author-response comment and NO commit AFTER it. Otherwise false. If true, list the concern bullets from that review in openConcerns. Do NOT modify anything.`
	);
}

function ciCheckPrompt(pr, iter) {
	return (
		`Report the current GitHub Actions status for PR #${pr} on ${REPO}. Poll ${iter}.\n` +
		`Run: \`timeout 120 gh pr checks ${pr} --repo ${REPO} --watch --interval 20 > /tmp/owlat_otw_ci_${pr}.txt 2>&1; echo "RC=$?"\` (--watch exits when checks finish; the 120s timeout caps this poll under the watchdog). Then \`gh pr checks ${pr} --repo ${REPO}\` once and read the table.\n` +
		`Classify: state="pass" if every check is pass/skipping/neutral; "fail" if ANY check failed; "pending" if any is queued/in_progress and none failed; "unknown" if NONE reported yet. List failing check names. Do NOT modify anything.`
	);
}

function reviewPrompt(p, build, round) {
	const f1Note = p.humanMerge
		? `\nF1 SPECIAL SCOPE: this is the GIANT integration PR — every constituent piece was already line-by-line reviewed on its own PR. Your review is a SIGN-OFF ON THE WHOLE, not a re-review of every hunk: verify the audit claims in the body (grep nodemailer yourself on the PR head via \`git show\`), verify the body links every constituent PR with honest verdicts, verify the final main-sync happened (PR is not behind ${MAIN}), verify CI is green on the exact merged tree, and spot-check the highest-risk surfaces (C2 taxonomy tests, C4 TLS-RPT tests, golden corpus present). Do NOT demand per-line changes that would reopen settled piece reviews unless you find a genuine defect.\n`
		: ``;
	return (
		`You are THE reviewer for PR #${build.prNumber} (${build.prUrl}) on ${REPO} (base branch: ${p.base || BASE}). Review ROUND ${round}. You are the single quality gate — you cover ALL areas below in one pass. The bar is: we only want the highest quality of code, and NO PIECE MERGES WITHOUT THE TESTS NAMED ON ITS CARD.\n` +
		f1Note +
		`\nREVIEW AREAS (cover every one; area 0 is the hard test gate):\n${REVIEWER_FOCUS}\n\n` +
		`THE SHARED PRODUCT BRIEF this PR must conform to:\n${BRIEF}\n\n` +
		`The PR implements this piece of the reviewed own-the-wire plan — judge it against THIS intent:\nPIECE: ${p.id} — ${p.title}\nSPEC:\n${p.spec}\nNAMED TESTS (the hard gate):\n${p.tests}\n` +
		(p.focus
			? `PIECE-SPECIFIC REVIEWER FOCUS (from the plan card — weight this heavily):\n${p.focus}\n`
			: ``) +
		`\nHOW TO REVIEW (read-only — do NOT checkout/modify the working tree or run the app):\n` +
		`- \`gh pr diff ${build.prNumber} --repo ${REPO}\` for the full diff; \`gh pr view ${build.prNumber} --repo ${REPO} --json title,body,commits,comments\` for context + prior-round comments.\n` +
		`- For full file context at the PR head without disturbing the tree: \`git -C "${ROOT}" fetch origin ${build.branch}\` then \`git -C "${ROOT}" show origin/${build.branch}:<path>\`. Read neighboring files on origin/${BASE} the same way when you need conventions context (e.g. apps/api/convex/CONVENTIONS.md).\n` +
		(round > 1
			? `- This is a RE-REVIEW: FIRST check whether your prior round's findings (blocking AND improvements) were addressed in the new commits. New findings are allowed only if the fix commits introduced them or you find a genuinely new defect — do not drip-feed nits you could have raised earlier.\n`
			: ``) +
		`\nFINDINGS POLICY — two buckets, BOTH get fixed:\n` +
		`- blockingFindings: defects — the test gate unmet (any named test surface missing or hollow), security issues (CRLF injection paths, TLS fail-open, AUTH before secured, credential/key logging), DOUBLE-DELIVERY taxonomy regressions (any post-DATA ambiguity classifiable as retryable), TLS-RPT result-type deltas, silent behavior deltas in anything the brief lists as semantics-preserving, spec violations, locked-decision violations (8BITMIME, socket reuse before X1, PIPELINING before X2, back-compat shims, string-matching on error messages), gutted existing test assertions, failing CI causes.\n` +
		`- improvements: everything that would make this the highest-quality version of itself — code-smell hits from the catalog, best-practice deviations, naming, small simplifications, better types. These are NOT optional notes: the author is instructed to address every one. Only report CONCRETE, actionable items with file:line and the fix — no vague "consider..." advice, no pure-taste style preferences, no speculative redesigns beyond the piece scope.\n\n` +
		`DECIDE: verdict="approve" ONLY if there are ZERO blocking findings AND ZERO unaddressed improvements AND the piece genuinely delivers its spec AND every named test surface exists and asserts the card's claims AND CI is not failing. If anything remains, verdict="request_changes" listing every item.\n\n` +
		`POST your review as ONE PR comment: \`gh pr comment ${build.prNumber} --repo ${REPO} --body "## Review — round ${round}\\n\\n**Verdict: APPROVE|REQUEST_CHANGES**\\n\\n### Test gate\\n<met / unmet: which named tests are missing>\\n\\n### Blocking\\n<list or 'none'>\\n\\n### Improvements\\n<list or 'none'>"\` (markdown lists with file:line). (Use a comment, NOT \`gh pr review\` — you cannot formally review a PR opened by your own gh user.)\n\n` +
		`Then return the structured verdict (it drives the pipeline's approval gate).`
	);
}

function addressPrompt(p, build, review, ci, round) {
	const WT = wtPath(p);
	const fmt = (arr) =>
		(arr || []).map((f) => `- ${f.file}${f.line ? ':' + f.line : ''} — ${f.issue}`).join('\n');
	const findings = review
		? `### Blocking\n${fmt(review.blockingFindings) || '(none)'}\n\n### Improvements (address these too — they are not optional)\n${fmt(review.improvements) || '(none)'}`
		: '';
	const ciNote =
		ci && ci.state === 'fail'
			? `\nGitHub CI is currently FAILING: ${ci.failing.join(', ')}. Investigate via \`gh pr checks ${build.prNumber} --repo ${REPO}\` and the linked job logs, and fix the cause.\n`
			: '';
	return (
		`You are the AUTHOR thread for PR #${build.prNumber} (${build.prUrl}) on ${REPO}, branch ${build.branch}, base ${p.base || BASE}. Address the reviewer's ACTUAL PR comments and push fixes. Fix ROUND ${round}.\n\n` +
		CONV +
		`\n` +
		`PIECE: ${p.id} — ${p.title}\nSPEC (intent to preserve):\n${p.spec}\n\nNAMED TESTS (hard gate — if the reviewer says one is missing, ADD it):\n${p.tests}\n\n` +
		`FINDINGS TO RESOLVE — address EVERY item, including the small improvements (the bar is the highest-quality version of this change, not merely a passing one):\n${findings || '(re-read the live PR comments)'}\n${ciNote}\n` +
		`Also read live comments: \`gh pr view ${build.prNumber} --repo ${REPO} --json comments\`.\n\n` +
		`STEPS:\n` +
		`1. Clean worktree at the PR head: \`git -C "${ROOT}" fetch origin ${build.branch}\`; \`git -C "${ROOT}" worktree remove --force "${WT}" 2>/dev/null || true\`; \`git -C "${ROOT}" worktree add --force "${WT}" origin/${build.branch}\`; then work under "${WT}" with \`git -C "${WT}"\`. (Detached HEAD is fine — you push explicitly.)\n` +
		`2. Fix each blocking finding (and any CI failure). If you believe a finding is wrong, that is allowed — justify it in the PR response and in \`unresolved\`. ATOMIC commits, NO AI attribution.\n` +
		`3. PREFLIGHT before re-pushing — run the local checks below and fix everything they flag:\n${PREFLIGHT}` +
		`4. Push: \`git -C "${WT}" push origin HEAD:${build.branch}\`. Post a response: \`gh pr comment ${build.prNumber} --repo ${REPO} --body "## Author response — round ${round}\\n\\n<what you addressed per reviewer + anything intentionally unchanged with reason>"\`. Then \`git -C "${ROOT}" worktree remove --force "${WT}" 2>/dev/null || true\`.\n\n` +
		`Return the structured result.`
	);
}

function mergePrompt(p, build, approved, ci) {
	const WT = wtPath(p);
	const green = ci && ci.state === 'pass';
	const ready = approved && green;
	return (
		`You are the MERGE gate for PR #${build.prNumber} (${build.prUrl}) on ${REPO}, branch ${build.branch}, BASE BRANCH ${BASE} (the integration branch — this pipeline NEVER merges to ${MAIN}). The unified reviewer ${approved ? 'APPROVED' : 'did NOT approve within the round budget'}; GitHub CI state is "${ci ? ci.state : 'unknown'}"${ci && ci.failing && ci.failing.length ? ' (failing: ' + ci.failing.join(', ') + ')' : ''}.\n\n` +
		(ready
			? `BOTH conditions are met (reviewer approval + CI green). This pipeline's merge policy was explicitly authorized by the repo owner (comment-verdict reviews stand in for formal approvals since the PR author and reviewer share one gh user). MERGE the PR now:\n` +
				`1. FIRST verify the base: \`gh pr view ${build.prNumber} --repo ${REPO} --json baseRefName\` must say ${BASE} — if it says anything else, DO NOT merge; return merged=false with the reason.\n` +
				`2. \`gh pr merge ${build.prNumber} --repo ${REPO} --squash --delete-branch\`.\n` +
				`3. If it fails because the branch is BEHIND ${BASE} (possible — sibling pieces merge in parallel), attempt ONE CLEAN rebase (never touch the main checkout): \`git -C "${ROOT}" fetch origin\`; \`git -C "${ROOT}" worktree remove --force "${WT}" 2>/dev/null || true\`; \`git -C "${ROOT}" worktree add --force "${WT}" origin/${build.branch}\`; \`git -C "${WT}" rebase origin/${BASE}\`.\n` +
				`   - If the rebase completes with NO conflicts: \`git -C "${WT}" push --force-with-lease origin HEAD:${build.branch}\`, remove the worktree, retry the merge (you may repeat this clean-rebase+retry up to TWO times — parallel merges race).\n` +
				`   - If the rebase STOPS ON CONFLICTS: capture the conflicted paths FIRST (\`git -C "${WT}" diff --name-only --diff-filter=U\`), then \`git -C "${WT}" rebase --abort\`, remove the worktree, and return merged=false, conflict=true, conflictFiles=<those paths>, with a one-line outstanding entry. Do NOT hand-resolve conflict hunks yourself — a dedicated resolver thread with the piece's full spec context handles that; your job is only to DETECT and CLASSIFY.\n` +
				`4. Confirm merged: \`gh pr view ${build.prNumber} --repo ${REPO} --json state,mergeCommit\`. Return merged=true with the merge commit only if state=MERGED.\n` +
				`If the merge cannot complete for a NON-conflict reason (protected-branch block, API error), return merged=false, conflict=false with the reason in outstanding — do NOT force anything unsafe.\n`
			: `NOT ready to merge (${approved ? 'CI not green' : 'reviewer did not approve'}). DO NOT MERGE. Post a PR comment summarizing exactly what still blocks merge (outstanding findings and/or failing checks) so a human can pick it up, and return merged=false with those items in \`outstanding\`.\n`) +
		`Return the structured result.`
	);
}

function resolveConflictPrompt(p, build, conflictFiles, attempt) {
	const WT = `${wtPath(p)}-resolve`;
	return (
		`You are the CONFLICT RESOLVER for PR #${build.prNumber} (${build.prUrl}) on ${REPO}, branch ${build.branch}, base ${BASE}. Attempt ${attempt}. The merge gate found the branch conflicts with ${BASE} after sibling pieces of this pipeline merged. Your job: rebase the branch onto origin/${BASE} and resolve every conflict SEMANTICALLY — you have the piece's full spec below, and the conflicting changes on ${BASE} come from sibling pieces of the same reviewed plan, so BOTH sides are intentional and BOTH intents must survive.\n\n` +
		CONV +
		`\n` +
		`PIECE (this branch's intent): ${p.id} — ${p.title}\nSPEC:\n${p.spec}\n\n` +
		`KNOWN CONFLICTED FILES (from the merge gate's probe): ${conflictFiles && conflictFiles.length ? conflictFiles.join(', ') : '(unknown — discover during rebase)'}\n\n` +
		`STEPS:\n` +
		`1. Dedicated worktree (never touch the main checkout): \`git -C "${ROOT}" fetch origin\`; \`git -C "${ROOT}" worktree remove --force "${WT}" 2>/dev/null || true\`; \`git -C "${ROOT}" worktree add --force "${WT}" origin/${build.branch}\`; then \`git -C "${WT}" rebase origin/${BASE}\`.\n` +
		`2. UNDERSTAND BEFORE RESOLVING each conflicted file: read the full conflicted file, then BOTH parents — \`git -C "${WT}" show REBASE_HEAD:<path>\` (this branch's version) and \`git -C "${WT}" show origin/${BASE}:<path>\` (what landed) — plus \`git -C "${WT}" log --oneline -8 origin/${BASE} -- <path>\` to see WHICH sibling piece changed it and why.\n` +
		`3. RESOLUTION POLICY: preserve BOTH behaviors — the sibling piece's merged change AND this piece's spec'd change. Never delete either side to make the conflict go away. If both sides restructured the same code incompatibly, keep ${BASE}'s structure as the base and RE-EXPRESS this piece's intent on top of it (the integration branch is the source of truth for architecture). A conflicted bun.lock is NEVER hand-merged: take either side, then regenerate with \`timeout 420 bun install --lockfile-only\` (sanctioned during conflict resolution) and stage the result. If a conflict reveals the two pieces genuinely contradict, STOP: return resolved=false with blockReason naming both sides — do not guess.\n` +
		`4. Continue the rebase to completion (\`git -C "${WT}" rebase --continue\` after each resolved commit; keep the branch's atomic-commit structure — do NOT squash during resolution).\n` +
		`5. PREFLIGHT the files you touched during resolution (oxfmt + oxlint as below) and self-review types:\n${PREFLIGHT}` +
		`6. Push: \`git -C "${WT}" push --force-with-lease origin HEAD:${build.branch}\`. Post a PR comment: \`gh pr comment ${build.prNumber} --repo ${REPO} --body "## Conflict resolution\\n\\nRebased onto ${BASE}; resolved: <files + one line each on how both intents were preserved>"\`. Clean up: \`git -C "${ROOT}" worktree remove --force "${WT}" 2>/dev/null || true\`.\n\n` +
		`GitHub Actions re-verifies the force-push — you do not wait for it. Return the structured result (resolved, pushed, files touched).`
	);
}

function mainSyncPrompt(waveNo) {
	const WT = `${SCRATCH}/main-sync-w${waveNo}`;
	return (
		`You are the MAIN-SYNC thread for the own-the-wire pipeline, after wave ${waveNo}. FRESHNESS RULE: merge origin/${MAIN} INTO the integration branch ${BASE} so the final giant PR stays reviewable instead of a mega-conflict. TRUNK WINS on conflict (the established resolution rule) — but "wins" means main's version is the BASE STRUCTURE; re-express the own-the-wire change on top of it, never silently drop an own-the-wire behavior.\n\n` +
		`STEPS (never touch the main checkout at ${ROOT} beyond \`git -C\` commands):\n` +
		`1. \`git -C "${ROOT}" fetch origin\`. Check whether a merge is even needed: \`git -C "${ROOT}" rev-list --count origin/${BASE}..origin/${MAIN}\` — if 0, return merged=true, pushed=false, conflicts=[], summary="integration branch already contains main". \n` +
		`2. \`git -C "${ROOT}" worktree remove --force "${WT}" 2>/dev/null || true\`; \`git -C "${ROOT}" worktree add --force "${WT}" origin/${BASE}\` (detached); \`git -C "${WT}" merge origin/${MAIN} -m "merge: main into ${BASE} (post-wave ${waveNo} freshness sync)"\`.\n` +
		`3. If conflicts: resolve per the trunk-wins policy above — for each conflicted file read both sides (\`git -C "${WT}" show HEAD:<path>\` vs \`git -C "${WT}" show origin/${MAIN}:<path>\`), take main's structure, re-apply the own-the-wire intent on top, \`git add\` and complete the merge commit. A conflicted bun.lock is NEVER hand-merged: take either side, regenerate with \`timeout 420 bun install --lockfile-only\`, stage the result. Preflight-format any file you hand-edited (\`oxfmt --config "${ROOT}/oxfmtrc.json" --write <files>\`).\n` +
		`4. Push: \`git -C "${WT}" push origin HEAD:${BASE}\`. Clean up: \`git -C "${ROOT}" worktree remove --force "${WT}" 2>/dev/null || true\`.\n` +
		`5. If a conflict is genuinely unresolvable without dropping one side's behavior, abort the merge, push NOTHING, and return merged=false with blockReason — a human decides.\n\n` +
		`NO AI attribution in the merge commit. Return the structured result (merged, pushed, conflicts=<files that had conflicts>, summary).`
	);
}

// ===========================================================================
// Orchestrator helpers
// ===========================================================================

// Review with the Fable->Opus fallback latch: use Fable while usage remains;
// the first time a Fable review returns null (usage/limit exhaustion or a
// terminal error), latch REVIEW_MODEL to Opus for the rest of the run and
// retry this review once on Opus.
let REVIEW_MODEL = 'fable';
async function runReview(p, build, round) {
	const opts = {
		label: `review:${p.id}:r${round}`,
		phase: 'Review',
		schema: REVIEW_SCHEMA,
		effort: 'high',
	};
	let review = await agent(reviewPrompt(p, build, round), { ...opts, model: REVIEW_MODEL });
	if (!review && REVIEW_MODEL === 'fable') {
		REVIEW_MODEL = 'opus';
		log(
			`${p.id} review r${round}: Fable unavailable — falling back to Opus for the remainder of the run`
		);
		review = await agent(reviewPrompt(p, build, round), { ...opts, model: 'opus' });
	}
	return review;
}

async function waitForCi(prNumber, pieceId) {
	let last = null;
	for (let i = 0; i < CI_POLLS; i++) {
		const s = await agent(ciCheckPrompt(prNumber, i + 1), {
			label: `ci:${pieceId}:${i + 1}`,
			phase: 'Verify',
			schema: CI_SCHEMA,
			model: 'sonnet',
			effort: 'low',
		});
		if (!s) continue;
		last = s;
		if (s.state === 'pass' || s.state === 'fail') {
			log(`${pieceId} CI: ${s.state}`);
			return s;
		}
	}
	log(`${pieceId} CI: timed out waiting (last=${last ? last.state : 'none'})`);
	return last || { state: 'unknown', failing: [], summary: 'no CI status obtained' };
}

// Full lifecycle for ONE piece: build -> CI -> review<->address loop -> merge
// (or, for F1: stop at approved+green for the human merge).
// Returns a result record; never throws (parallel siblings must not die together).
async function runPiece(p, idx, total, mergedSet) {
	const failedDeps = (p.dependsOn || []).filter((d) => !mergedSet.has(d));
	if (failedDeps.length) {
		log(
			`${p.id} — SKIPPED (unmerged deps: ${failedDeps.join(', ')})${p.optional ? ' [optional capability dropped]' : ''}`
		);
		return {
			piece: p.id,
			opened: false,
			merged: false,
			reason: 'skipped: unmerged deps ' + failedDeps.join(','),
		};
	}
	log(`[${idx}/${total}] ${p.id} — building`);
	try {
		const droppedCapabilities = p.humanMerge
			? ['X1', 'X2', 'X3', 'X4'].filter((x) => !mergedSet.has(x))
			: [];
		const build = await agent(buildPrompt(p, droppedCapabilities), {
			label: `build:${p.id}`,
			phase: 'Build',
			schema: BUILD_SCHEMA,
			model: 'opus',
			effort: p.id === 'C4' ? 'high' : 'medium',
		});
		if (build && build.alreadyLanded) {
			log(`${p.id} already landed on ${BASE} (PR #${build.prNumber || '?'}) — counting as merged`);
			return {
				piece: p.id,
				opened: false,
				merged: true,
				prNumber: build.prNumber,
				reason: 'already landed on ' + BASE,
			};
		}
		if (!build || !build.opened || !build.prNumber) {
			log(`build failed for ${p.id}: ${(build && build.blockReason) || 'agent died / rate limit'}`);
			return {
				piece: p.id,
				opened: false,
				merged: false,
				reason: (build && build.blockReason) || 'build agent failed',
			};
		}
		log(`${p.id} -> PR #${build.prNumber}${build.reused ? ' (reused)' : ''} ${build.prUrl}`);

		// ADOPTED PR: a previous run may have left a reviewer verdict as the last
		// word on the PR. If so, address its concerns FIRST.
		if (build.reused) {
			const st = await agent(prStatePrompt(build.prNumber), {
				label: `pr-state:${p.id}`,
				phase: 'Verify',
				schema: PR_STATE_SCHEMA,
				model: 'sonnet',
				effort: 'low',
			});
			if (st && st.lastIsUnaddressedReview) {
				log(
					`${p.id} adopted PR has an unaddressed review (${(st.openConcerns || []).length} concerns) — addressing before re-review`
				);
				await agent(addressPrompt(p, build, null, null, 0), {
					label: `address:${p.id}:adopted`,
					phase: 'Address',
					schema: ADDRESS_SCHEMA,
					model: 'opus',
					effort: 'medium',
				});
			}
		}

		// GitHub Actions verifies the pushed build before reviewing.
		let ci = await waitForCi(build.prNumber, p.id);

		// Unified reviewer (Fable->Opus latch) <-> Opus author loop until approve AND CI green.
		let approved = false;
		for (let round = 1; round <= MAX_ROUNDS; round++) {
			const review = await runReview(p, build, round);
			const ok = !!review && review.verdict === 'approve';
			const openItems = review
				? (review.blockingFindings || []).length + (review.improvements || []).length
				: -1;
			log(
				`${p.id} round ${round}: ${ok ? 'APPROVE' : review ? `request_changes (${openItems} items)` : 'reviewer died'}; CI=${ci.state}`
			);
			if (ok && ci.state === 'pass') {
				approved = true;
				break;
			}
			if (round === MAX_ROUNDS) {
				approved = ok;
				// INVARIANT: a request_changes review is NEVER the last word on a PR.
				if (!ok && review) {
					log(
						`${p.id} round budget spent with open findings — final address pass so the review does not go unanswered`
					);
					await agent(addressPrompt(p, build, review, ci, round + 1), {
						label: `address:${p.id}:final`,
						phase: 'Address',
						schema: ADDRESS_SCHEMA,
						model: 'opus',
						effort: 'medium',
					});
					ci = await waitForCi(build.prNumber, p.id);
				}
				break;
			}

			await agent(addressPrompt(p, build, review, ci, round + 1), {
				label: `address:${p.id}:r${round + 1}`,
				phase: 'Address',
				schema: ADDRESS_SCHEMA,
				model: 'opus',
				effort: 'medium',
			});
			ci = await waitForCi(build.prNumber, p.id);
		}

		// F1 is HUMAN-MERGED: stop at approved+green, never call the merge gate.
		if (p.humanMerge) {
			const humanReady = approved && ci.state === 'pass';
			log(
				`${p.id} giant PR #${build.prNumber}: ${humanReady ? 'READY FOR HUMAN MERGE (approved + CI green)' : `NOT ready (approved=${approved}, CI=${ci.state}) — needs human attention`} ${build.prUrl}`
			);
			return {
				piece: p.id,
				opened: true,
				reused: !!build.reused,
				prNumber: build.prNumber,
				prUrl: build.prUrl,
				approved,
				ciState: ci.state,
				merged: false,
				humanReady,
				outstanding: humanReady ? [] : ['awaiting human decision on the giant PR'],
			};
		}

		// Merge on approve+green; a detected CONFLICT spawns a dedicated Opus
		// resolver, CI re-verifies, then the merge retries.
		let merged = false;
		let mergeOut = [];
		if (AUTO_MERGE) {
			for (let attempt = 1; attempt <= MERGE_ATTEMPTS && !merged; attempt++) {
				const m = await agent(mergePrompt(p, build, approved, ci), {
					label: `merge:${p.id}:a${attempt}`,
					phase: 'Merge',
					schema: MERGE_SCHEMA,
					model: 'sonnet',
					effort: 'low',
				});
				merged = !!(m && m.merged);
				mergeOut = (m && m.outstanding) || [];
				if (merged || !(m && m.conflict)) break;

				log(
					`${p.id} merge blocked by CONFLICT (attempt ${attempt}): ${(m.conflictFiles || []).join(', ') || 'files unknown'} — spawning resolver`
				);
				const res = await agent(resolveConflictPrompt(p, build, m.conflictFiles || [], attempt), {
					label: `resolve:${p.id}:a${attempt}`,
					phase: 'Merge',
					schema: RESOLVE_SCHEMA,
					model: 'opus',
					effort: 'medium',
				});
				if (!res || !res.pushed) {
					mergeOut = [
						'conflict resolution failed: ' + ((res && res.blockReason) || 'resolver died'),
					];
					log(`${p.id} resolver did not push — leaving for human (${mergeOut[0]})`);
					break;
				}

				ci = await waitForCi(build.prNumber, p.id);
				if (ci.state !== 'pass') {
					await agent(addressPrompt(p, build, null, ci, MAX_ROUNDS + attempt), {
						label: `address:${p.id}:post-resolve${attempt}`,
						phase: 'Address',
						schema: ADDRESS_SCHEMA,
						model: 'opus',
						effort: 'medium',
					});
					ci = await waitForCi(build.prNumber, p.id);
					if (ci.state !== 'pass') {
						mergeOut = ['CI not green after conflict resolution'];
						log(`${p.id} CI still ${ci.state} after post-resolve repair — leaving for human`);
						break;
					}
				}
			}
			log(
				`${p.id} ${merged ? 'MERGED into ' + BASE : 'NOT merged'}${merged ? '' : ' — ' + mergeOut.join('; ')}`
			);
		} else {
			log(`${p.id} approve=${approved} ci=${ci.state} — AUTO_MERGE off, leaving for human`);
		}
		return {
			piece: p.id,
			opened: true,
			reused: !!build.reused,
			prNumber: build.prNumber,
			prUrl: build.prUrl,
			approved,
			ciState: ci.state,
			merged,
			outstanding: mergeOut,
		};
	} catch (e) {
		log(`${p.id} FAILED (caught): ${String(e).slice(0, 160)} — continuing`);
		return {
			piece: p.id,
			opened: false,
			merged: false,
			reason: 'caught: ' + String(e).slice(0, 140),
		};
	}
}

// ===========================================================================
// Driver — explicit WAVES of parallel TRACKS (serial inside a track, so
// in-wave dependency chains like C3 -> C4 and X1 -> X2 -> X3 -> X4 work).
// Waves are barriers. After each wave with >=1 merge, origin/main is merged
// INTO the integration branch (trunk wins). Optional (X) pieces that fail
// drop their capability (dep-gate skips the rest of the X chain) — F1 still
// runs and notes them; a failed NON-optional piece blocks F1 transitively
// through the dep graph. On a rate-limit/stall resume: add merged ids to
// MERGED_IDS and relaunch FRESH — builders branch from origin/BASE, and the
// reuse-check adopts still-open PRs from the previous run. TRUST
// `gh pr list --state merged` over a resumed run's cached result JSON.
// ===========================================================================
const byId = Object.fromEntries(PIECES.map((p) => [p.id, p]));
const MERGED_IDS = [
	// Add piece ids here when resuming after a stall (confirmed merged into the
	// integration branch via `gh pr list --repo wolvesdotink/owlat --base integration/own-the-wire --state merged`).
];
const RUN_WAVES = WAVES.map((wave) =>
	wave
		.map((track) => track.filter((id) => !MERGED_IDS.includes(id)))
		.filter((track) => track.length > 0)
).filter((wave) => wave.length > 0);

const total = RUN_WAVES.flat(2).length;
log(
	`nodemailer-removal-prs: ${total} piece(s) in ${RUN_WAVES.length} wave(s) (auto-merge=${AUTO_MERGE}) vs ${REPO}, base ${BASE}`
);
RUN_WAVES.forEach((w, i) => log(`wave ${i + 1}: ${w.map((t) => t.join(' -> ')).join(' | ')}`));

const results = [];
const mergedSet = new Set(MERGED_IDS);
let counter = 0;

for (let w = 0; w < RUN_WAVES.length; w++) {
	const wave = RUN_WAVES[w];
	phase(`Wave ${w + 1}`);
	log(`=== wave ${w + 1}/${RUN_WAVES.length}: ${wave.map((t) => t.join(' -> ')).join(' | ')} ===`);

	// Tracks in parallel; pieces inside a track serially (later track pieces
	// depend on earlier ones — the dep-gate in runPiece enforces it too).
	const waveResults = await parallel(
		wave.map((track) => async () => {
			const trackResults = [];
			for (const id of track) {
				counter++;
				const r = await runPiece(byId[id], counter, total, mergedSet);
				trackResults.push(r);
				if (r && r.merged) mergedSet.add(r.piece);
			}
			return trackResults;
		})
	);

	for (const r of waveResults.filter(Boolean).flat()) results.push(r);

	const flatWave = waveResults.filter(Boolean).flat();
	const waveMergedCount = flatWave.filter((r) => r && r.merged).length;
	const waveHumanReady = flatWave.some((r) => r && r.humanReady);
	const wavePieceCount = wave.flat().length;
	log(`wave ${w + 1} done: ${waveMergedCount}/${wavePieceCount} merged into ${BASE}`);

	if (
		ABORT_IF_WHOLE_WAVE_FAILS &&
		wavePieceCount > 1 &&
		waveMergedCount === 0 &&
		!waveHumanReady &&
		!wave.flat().every((id) => byId[id].optional)
	) {
		log(
			`ABORT: entire wave ${w + 1} failed to merge — likely rate limit or systemic issue. Fix and resume via MERGED_IDS.`
		);
		break;
	}

	// Freshness rule: after each wave with merges, fold main INTO the
	// integration branch (trunk wins) so the final giant PR stays reviewable.
	// (Not after F1's wave — F1 does its own final sync before opening the PR.)
	const isFinalWave = wave.flat().includes('F1');
	if (waveMergedCount > 0 && !isFinalWave) {
		phase(`Sync ${w + 1}`);
		const sync = await agent(mainSyncPrompt(w + 1), {
			label: `main-sync:w${w + 1}`,
			phase: `Sync ${w + 1}`,
			schema: SYNC_SCHEMA,
			model: 'opus',
			effort: 'medium',
		});
		if (!sync || !sync.merged) {
			log(
				`main-sync after wave ${w + 1} FAILED: ${(sync && sync.blockReason) || 'agent died'} — STOPPING so the divergence is handled by a human before more pieces stack on top`
			);
			break;
		}
		log(
			`main-sync after wave ${w + 1}: ${sync.pushed ? 'merged + pushed' : 'nothing to merge'}${(sync.conflicts || []).length ? ' (conflicts resolved: ' + sync.conflicts.join(', ') + ')' : ''}`
		);
	}
}

const mergedCount = results.filter((r) => r.merged).length;
const openedNotMerged = results.filter((r) => r.opened && !r.merged && !r.humanReady);
const f1 = results.find((r) => r.piece === 'F1');
log(
	`DONE — ${mergedCount}/${total - 1} piece PRs merged into ${BASE}; ${openedNotMerged.length} opened-but-unmerged. Giant PR: ${f1 ? (f1.humanReady ? `READY FOR MARCEL'S REVIEW+MERGE: ${f1.prUrl}` : f1.prUrl ? `opened but NOT ready (${(f1.outstanding || []).join('; ')}): ${f1.prUrl}` : 'not opened — ' + (f1.reason || 'blocked')) : 'not reached'}`
);
return {
	repo: REPO,
	base: BASE,
	mergedCount,
	total,
	giantPr: f1 || null,
	waves: RUN_WAVES.map((w) => w.map((t) => t.join('->'))),
	results,
};
