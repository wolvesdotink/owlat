/**
 * Turns a GitHub Release body into what the in-app update card shows: the
 * summary, the changes grouped by kind, and the "before you update" note.
 *
 * Two body shapes reach the card. Releases cut since `scripts/release-body.ts`
 * lead with the curated CHANGELOG.md section (a prose lead-in, an
 * **Upgrading.** paragraph, then `### Added` / `### Changed` / `### Fixed`)
 * and end with a `## Updating` section. Older releases lead with install
 * commands and end with GitHub's generated "What's Changed" PR list, whose
 * entries are conventional-commit subjects. Install commands, code blocks and
 * the image list are dropped from both: the card links to the update guide
 * instead.
 */
import { parseInlines, parseMarkdown, type Block, type Inline } from '~/utils/markdown';

export const OWLAT_REPO_URL = 'https://github.com/wolvesdotink/owlat';

export type ReleaseChangeKind =
	| 'breaking'
	| 'security'
	| 'added'
	| 'changed'
	| 'fixed'
	| 'removed'
	| 'docs'
	| 'maintenance'
	| 'other';

/** Display order, most important first. */
export const RELEASE_CHANGE_KINDS: readonly ReleaseChangeKind[] = [
	'breaking',
	'security',
	'added',
	'changed',
	'fixed',
	'removed',
	'docs',
	'maintenance',
	'other',
];

export interface ReleaseChangeGroup {
	kind: ReleaseChangeKind;
	items: Inline[][];
}

/** A paragraph or a bullet list, the two block shapes the card renders. */
export type ReleaseProse =
	| { type: 'paragraph'; inlines: Inline[] }
	| { type: 'list'; items: Inline[][] };

export interface ReleaseNotes {
	summary: ReleaseProse[];
	upgrading: ReleaseProse[];
	groups: ReleaseChangeGroup[];
}

/** `### <title>` → the kind it holds. `auto` classifies each entry by its commit type. */
const SECTION_KINDS: [RegExp, ReleaseChangeKind | 'auto' | 'skip'][] = [
	[/^breaking/i, 'breaking'],
	[/^security/i, 'security'],
	[/^(added|new features?|features?)$/i, 'added'],
	[/^(changed|improve(d|ments)|performance)$/i, 'changed'],
	[/^(fixed|bug ?fixes|fixes)$/i, 'fixed'],
	[/^(removed|deprecated)$/i, 'removed'],
	[/^(documentation|docs)$/i, 'docs'],
	// Install instructions: the card links to the update guide instead.
	[/^(self-hosted server|desktop app|manual upgrade|supply-chain verification)/i, 'skip'],
];

/** Top-level headings whose content is update instructions, not changes. */
const INSTRUCTION_HEADING = /^(updating|installing|how to update|upgrading)\b/i;

const COMMIT_SUBJECT = /^([a-z]+)(\([^)]*\))?(!)?:\s*/i;
const COMMIT_KINDS: Record<string, ReleaseChangeKind> = {
	feat: 'added',
	perf: 'changed',
	fix: 'fixed',
	revert: 'fixed',
	security: 'security',
	docs: 'docs',
};

/** GitHub's generated suffix: `… by @someone in https://github.com/o/r/pull/123`. */
const PR_SUFFIX =
	/\s+by @[\w-]+(?:\[bot\])?\s+in\s+(https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+))\s*$/;

const PR_REF = /#(\d+)\b/g;

function textOf(inlines: Inline[]): string {
	return inlines.map((p) => p.value).join('');
}

/**
 * `parseInlines` keeps a bold span flat, so `**The `X` flag**` would show its
 * backticks. Split such a span into bold text around the code.
 */
function splitBoldCode(inlines: Inline[]): Inline[] {
	return inlines.flatMap((part) =>
		part.type === 'strong' && part.value.includes('`')
			? parseInlines(part.value).map((p) =>
					p.type === 'text' ? { type: 'strong' as const, value: p.value } : p
				)
			: [part]
	);
}

/** `(#1241, #1248)` → links to the pull requests. */
function linkPullRequests(inlines: Inline[]): Inline[] {
	return inlines.flatMap((part): Inline[] => {
		if (part.type !== 'text') return [part];
		const out: Inline[] = [];
		let last = 0;
		for (const m of part.value.matchAll(PR_REF)) {
			const at = m.index ?? 0;
			if (at > last) out.push({ type: 'text', value: part.value.slice(last, at) });
			out.push({ type: 'link', value: m[0], href: `${OWLAT_REPO_URL}/pull/${m[1]}` });
			last = at + m[0].length;
		}
		if (last < part.value.length) out.push({ type: 'text', value: part.value.slice(last) });
		return out;
	});
}

function tidy(inlines: Inline[]): Inline[] {
	return linkPullRequests(splitBoldCode(inlines));
}

/** One generated "What's Changed" entry → its kind and a readable sentence. */
function legacyEntry(inlines: Inline[]): { kind: ReleaseChangeKind; inlines: Inline[] } {
	let kind: ReleaseChangeKind = 'other';
	const parts = inlines.map((p) => ({ ...p }));

	const first = parts[0];
	if (first?.type === 'text') {
		const commit = COMMIT_SUBJECT.exec(first.value);
		if (commit) {
			const type = commit[1]?.toLowerCase() ?? '';
			kind = commit[3] ? 'breaking' : (COMMIT_KINDS[type] ?? 'maintenance');
			const rest = first.value.slice(commit[0].length);
			first.value = rest.charAt(0).toUpperCase() + rest.slice(1);
		}
	}

	const last = parts[parts.length - 1];
	if (last?.type === 'text') {
		const pr = PR_SUFFIX.exec(last.value);
		if (pr) {
			last.value = `${last.value.slice(0, pr.index)} (#${pr[2]})`;
		}
	}
	return { kind, inlines: tidy(parts.filter((p) => p.value !== '')) };
}

function isUpgradingLabel(part: Inline | undefined): boolean {
	return part?.type === 'strong' && /^upgrading\b/i.test(part.value.trim());
}

/** Lines that only point somewhere else: the image list and the compare link. */
function isBoilerplate(inlines: Inline[]): boolean {
	const first = inlines[0];
	return first?.type === 'strong' && /^(images|full changelog)\b/i.test(first.value.trim());
}

const LIST_ITEM = /^\s*([-*+]|\d+\.)\s+/;
const CONTINUATION = /^\s{2,}\S/;

/**
 * Joins a bullet's indented continuation lines onto the bullet. CHANGELOG.md
 * wraps long entries, and the shared parser only reads a list item's first
 * line — the rest would come out as a separate paragraph and be dropped here.
 */
function unwrapListItems(source: string): string {
	const out: string[] = [];
	let inFence = false;
	let inItem = false;
	for (const line of source.split('\n')) {
		if (/^\s*```/.test(line)) inFence = !inFence;
		if (!inFence && inItem && CONTINUATION.test(line) && !LIST_ITEM.test(line)) {
			out[out.length - 1] += ` ${line.trim()}`;
			continue;
		}
		inItem = !inFence && LIST_ITEM.test(line);
		out.push(line);
	}
	return out.join('\n');
}

export function parseReleaseNotes(source: string): ReleaseNotes {
	const cleaned = source.replace(/\r\n/g, '\n').replace(/<!--[\s\S]*?-->/g, '');
	const blocks: Block[] = parseMarkdown(unwrapListItems(cleaned));
	const summary: ReleaseProse[] = [];
	const upgrading: ReleaseProse[] = [];
	const groups = new Map<ReleaseChangeKind, Inline[][]>();
	const add = (kind: ReleaseChangeKind, inlines: Inline[]) => {
		const list = groups.get(kind) ?? [];
		list.push(inlines);
		groups.set(kind, list);
	};

	// intro: lead-in prose · section: a change list · legacy: GitHub's
	// generated list · skip: install instructions
	let mode: 'intro' | 'section' | 'legacy' | 'skip' = 'intro';
	let sectionKind: ReleaseChangeKind | 'auto' = 'other';
	let inUpgrading = false;

	for (const block of blocks) {
		if (block.type === 'heading') {
			const title = textOf(block.inlines).trim();
			if (block.level <= 2) {
				if (/^what'?s changed/i.test(title)) mode = 'legacy';
				else if (INSTRUCTION_HEADING.test(title)) mode = 'skip';
				// `## Owlat v1.2.3` / `## [1.2.3] - date`: the release's own title.
				else mode = /^(owlat\s+)?\[?v?\d+\.\d+/i.test(title) ? 'intro' : 'skip';
				inUpgrading = false;
				continue;
			}
			const match = SECTION_KINDS.find(([re]) => re.test(title))?.[1];
			if (match === 'skip' || (mode === 'skip' && match === undefined)) {
				mode = 'skip';
			} else if (mode === 'legacy') {
				// GitHub's categories (Other Changes, API & Backend, …) say little;
				// the commit type of each entry says more.
				sectionKind = match && match !== 'auto' ? match : 'auto';
			} else {
				mode = 'section';
				sectionKind = match ?? 'other';
			}
			inUpgrading = false;
			continue;
		}

		if (mode === 'skip' || block.type === 'code' || block.type === 'hr') continue;

		if (block.type === 'list') {
			if (mode === 'intro') {
				(inUpgrading ? upgrading : summary).push({ type: 'list', items: block.items.map(tidy) });
			} else if (mode === 'legacy') {
				for (const item of block.items) {
					const entry = legacyEntry(item);
					add(sectionKind === 'auto' ? entry.kind : sectionKind, entry.inlines);
				}
			} else {
				for (const item of block.items)
					add(sectionKind === 'auto' ? 'other' : sectionKind, tidy(item));
			}
			continue;
		}

		if (block.type !== 'paragraph' || mode !== 'intro' || isBoilerplate(block.inlines)) continue;

		if (isUpgradingLabel(block.inlines[0])) {
			inUpgrading = true;
			const rest = block.inlines.slice(1);
			const head = rest[0];
			if (head?.type === 'text') rest[0] = { ...head, value: head.value.trimStart() };
			if (rest.some((p) => p.value.trim() !== '')) {
				upgrading.push({ type: 'paragraph', inlines: tidy(rest) });
			}
			continue;
		}
		(inUpgrading ? upgrading : summary).push({ type: 'paragraph', inlines: tidy(block.inlines) });
	}

	return {
		summary,
		upgrading,
		groups: RELEASE_CHANGE_KINDS.filter((kind) => groups.has(kind)).map((kind) => ({
			kind,
			items: groups.get(kind) ?? [],
		})),
	};
}

export function hasReleaseNotes(notes: ReleaseNotes): boolean {
	return notes.summary.length > 0 || notes.upgrading.length > 0 || notes.groups.length > 0;
}
