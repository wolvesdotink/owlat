import { describe, expect, it } from 'vitest';
import type { Inline } from '~/utils/markdown';
import { hasReleaseNotes, parseReleaseNotes } from '~/utils/releaseNotes';

const text = (inlines: Inline[]) => inlines.map((p) => p.value).join('');

// The shape scripts/release-body.ts writes: the CHANGELOG section, then how to update.
const CURATED = `A fix release. Mandrill webhooks are filtered by subaccount (#1248).

**Upgrading.** Deploy the backend first; the in-app update does.

- **Web Push needs a VAPID key pair.** Add \`VAPID_PUBLIC_KEY\`.

### Added

- **Saved replies.** Type \`;\` and a shortcut. (#1156)
- **Brand kit.** Logo and palette. (#1159)

### Fixed

- **The deployment's \`OWLAT_VERSION\` is set after every function deploy.** (#1179)

### Documentation

- Every in-site anchor link is checked. (#1234)

## Updating

**Self-hosted server:** open **Settings → System & updates** and click **Update now**.

### Manual upgrade

\`\`\`sh
docker compose up -d
\`\`\`

**Images:** \`web\`, \`mta\` — all \`ghcr.io/wolvesdotink/<name>:0.6.9\`

**Full changelog:** https://github.com/wolvesdotink/owlat/compare/v0.6.8...v0.6.9
`;

// The shape releases up to v0.6.9 carry: install commands, then GitHub's generated list.
const LEGACY = `## Owlat v0.6.9

### Self-hosted server

From the admin dashboard → **Settings → System & Updates** → "Update now", or:

\`\`\`sh
owlat upgrade --version 0.6.9
\`\`\`

### Desktop app

Download the installer for your OS from the assets below.

### Supply-chain verification (recommended)

**Images:** \`web\`, \`mta\` — all \`ghcr.io/wolvesdotink/<name>:0.6.9\`

<!-- Release notes generated using configuration in .github/release.yml at v0.6.9 -->

## What's Changed
### Other Changes
* fix(web): keep test helpers out of the production build by @marcelxpfeifer in https://github.com/wolvesdotink/owlat/pull/1174
* feat(inbox): saved replies by @someone in https://github.com/wolvesdotink/owlat/pull/1156
* perf(imap): run the folder backfill without an operator step by @marcelxpfeifer in https://github.com/wolvesdotink/owlat/pull/1215
* test(api): pin the send-time test to midnight by @marcelxpfeifer in https://github.com/wolvesdotink/owlat/pull/1198
* feat(api)!: drop the v1 webhook payload by @marcelxpfeifer in https://github.com/wolvesdotink/owlat/pull/1300


**Full Changelog**: https://github.com/wolvesdotink/owlat/compare/v0.6.8...v0.6.9
`;

describe('parseReleaseNotes — curated body', () => {
	const notes = parseReleaseNotes(CURATED);

	it('keeps the lead-in as the summary and links its PR refs', () => {
		expect(notes.summary).toHaveLength(1);
		const para = notes.summary[0]!;
		expect(para.type).toBe('paragraph');
		if (para.type !== 'paragraph') return;
		expect(text(para.inlines)).toBe(
			'A fix release. Mandrill webhooks are filtered by subaccount (#1248).'
		);
		expect(para.inlines).toContainEqual({
			type: 'link',
			value: '#1248',
			href: 'https://github.com/wolvesdotink/owlat/pull/1248',
		});
	});

	it('moves the Upgrading paragraph and its bullets into the before-you-update note', () => {
		expect(notes.upgrading.map((b) => b.type)).toEqual(['paragraph', 'list']);
		const para = notes.upgrading[0]!;
		if (para.type !== 'paragraph') throw new Error('expected a paragraph');
		expect(text(para.inlines)).toBe('Deploy the backend first; the in-app update does.');
	});

	it('groups the change lists by kind, in display order', () => {
		expect(notes.groups.map((g) => [g.kind, g.items.length])).toEqual([
			['added', 2],
			['fixed', 1],
			['docs', 1],
		]);
	});

	it('renders code inside a bold lead sentence as code', () => {
		const item = notes.groups.find((g) => g.kind === 'fixed')!.items[0]!;
		expect(item.slice(0, 3)).toEqual([
			{ type: 'strong', value: "The deployment's " },
			{ type: 'code', value: 'OWLAT_VERSION' },
			{ type: 'strong', value: ' is set after every function deploy.' },
		]);
	});

	it('drops the update instructions, code blocks and link lines', () => {
		const all = JSON.stringify(notes);
		expect(all).not.toContain('docker compose');
		expect(all).not.toContain('Self-hosted server');
		expect(all).not.toContain('Images');
		expect(all).not.toContain('Full changelog');
	});
});

describe('parseReleaseNotes — generated (pre-0.6.10) body', () => {
	const notes = parseReleaseNotes(LEGACY);

	it('skips the install sections entirely', () => {
		expect(notes.summary).toEqual([]);
		expect(notes.upgrading).toEqual([]);
		expect(JSON.stringify(notes)).not.toContain('owlat upgrade');
	});

	it('classifies entries by commit type and turns the PR suffix into a link', () => {
		expect(notes.groups.map((g) => [g.kind, g.items.map(text)])).toEqual([
			['breaking', ['Drop the v1 webhook payload (#1300)']],
			['added', ['Saved replies (#1156)']],
			['changed', ['Run the folder backfill without an operator step (#1215)']],
			['fixed', ['Keep test helpers out of the production build (#1174)']],
			['maintenance', ['Pin the send-time test to midnight (#1198)']],
		]);
		const added = notes.groups.find((g) => g.kind === 'added')!.items[0]!;
		expect(added.at(-1)).toEqual({ type: 'text', value: ')' });
		expect(added).toContainEqual({
			type: 'link',
			value: '#1156',
			href: 'https://github.com/wolvesdotink/owlat/pull/1156',
		});
	});
});

describe('parseReleaseNotes — wrapped lines', () => {
	// CHANGELOG.md wraps long entries (0.5.3 is written this way).
	const notes =
		parseReleaseNotes(`Three fixes to things that had gone visibly wrong: message bodies rendering as
ciphertext, and a failed update.

**Upgrading.** No schema change. A stale queue can be re-checked with
\`convex run migrations/0045_recheck_needs_reply:run\`.

### Fixed

- **Message bodies are unsealed at the read boundary.** Opening a message in
  the Postbox rendered \`atrest:1:<iv>:<ciphertext>\` instead of the mail. (#743)
- **Only mail that wants a reply reaches the Reply Queue.** Both stages are
  tightened.
- **A failed update restarts the stack instead of leaving it dark.** Compose recreate is "create new, stop old, start new", so a \`docker
compose up\` that dies mid-way leaves the old containers stopped. (#742)

### Documentation

- Every anchor link is checked.
### Changed
- **Indented continuation.**
  Still the same bullet.

\`\`\`sh
- not a bullet
  nor a continuation
\`\`\`
`);

	it("keeps a bullet's continuation lines in the bullet", () => {
		const fixed = notes.groups.find((g) => g.kind === 'fixed')!;
		expect(fixed.items.map(text)).toEqual([
			'Message bodies are unsealed at the read boundary. Opening a message in the Postbox rendered atrest:1:<iv>:<ciphertext> instead of the mail. (#743)',
			'Only mail that wants a reply reaches the Reply Queue. Both stages are tightened.',
			'A failed update restarts the stack instead of leaving it dark. Compose recreate is "create new, stop old, start new", so a docker compose up that dies mid-way leaves the old containers stopped. (#742)',
		]);
		expect(fixed.items[2]).toContainEqual({ type: 'code', value: 'docker compose up' });
		expect(fixed.items[0]).toContainEqual({ type: 'code', value: 'atrest:1:<iv>:<ciphertext>' });
	});

	it('stops a bullet at a heading, even without a blank line', () => {
		expect(notes.groups.find((g) => g.kind === 'docs')!.items.map(text)).toEqual([
			'Every anchor link is checked.',
		]);
		expect(notes.groups.find((g) => g.kind === 'changed')!.items.map(text)).toEqual([
			'Indented continuation. Still the same bullet.',
		]);
	});

	it('joins wrapped paragraphs and leaves code blocks alone', () => {
		expect(notes.summary.map((b) => (b.type === 'paragraph' ? text(b.inlines) : ''))).toEqual([
			'Three fixes to things that had gone visibly wrong: message bodies rendering as ciphertext, and a failed update.',
		]);
		expect(notes.upgrading).toHaveLength(1);
		expect(JSON.stringify(notes)).not.toContain('not a bullet');
	});
});

describe('hasReleaseNotes', () => {
	it('is false for a body that is only install instructions', () => {
		expect(hasReleaseNotes(parseReleaseNotes('## Updating\n\n```sh\nowlat upgrade\n```\n'))).toBe(
			false
		);
		expect(hasReleaseNotes(parseReleaseNotes(''))).toBe(false);
	});

	it('is true for plain prose', () => {
		expect(hasReleaseNotes(parseReleaseNotes('Just a small fix.'))).toBe(true);
	});
});
