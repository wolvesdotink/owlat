#!/usr/bin/env python3
"""
Migrate apps/api/convex/<prefix>*.ts into apps/api/convex/<domain>/.

Per CONVENTIONS.md, drops the redundant prefix from filenames once they're
inside the folder:
    mailIdentities.ts -> mail/identities.ts
    campaignsScheduling.ts -> campaigns/scheduling.ts

After moving, rewrites:
    1. Internal Convex imports `./<prefix>X` -> path adjustment
    2. Generated API references `api.<prefix>X.*` and `internal.<prefix>X.*`
       -> `api.<domain>.<x>.*` and `internal.<domain>.<x>.*`
       across the whole repo (apps/, packages/) excluding _generated and
       node_modules.

Idempotent: re-running after success is a no-op.

Usage:
    python3 migrate_domain.py <prefix> [--domain=<folder>]

If --domain is omitted, the prefix doubles as the folder name.

After running, also run `fix_moved_imports.py <domain>` to fix the moved
files' OWN relative imports (`./lib/X` -> `../lib/X`).

Examples:
    python3 migrate_domain.py mail        # mailX.ts -> mail/X.ts
    python3 migrate_domain.py campaigns   # campaignsX.ts -> campaigns/X.ts
"""

import re
import shutil
import sys
from pathlib import Path

REPO = Path('/Users/marcel/Code/WLS - wolves/owlat')
CONVEX = REPO / 'apps' / 'api' / 'convex'

# CLI args (optional — defaults preserve original `mail` behavior).
PREFIX = 'mail'
DOMAIN = 'mail'
for i, arg in enumerate(sys.argv[1:], start=1):
    if arg.startswith('--domain='):
        DOMAIN = arg.split('=', 1)[1]
    elif not arg.startswith('--'):
        PREFIX = arg
        if DOMAIN == 'mail' and i == 1:
            DOMAIN = arg

MAIL_DIR = CONVEX / DOMAIN  # name kept for backwards compatibility within the file

# Discover the files to migrate (top-level only).
SOURCES = sorted(
    p for p in CONVEX.glob(f'{PREFIX}*.ts')
    if p.is_file() and p.parent == CONVEX
)


def new_basename(old: str) -> str:
    """<prefix>Identities.ts -> identities.ts"""
    assert old.startswith(PREFIX) and old.endswith('.ts')
    stem = old[len(PREFIX):-len('.ts')]
    if not stem:
        return old  # <prefix>.ts standalone — keep
    return stem[0].lower() + stem[1:] + '.ts'


def stem_of(old: str) -> str:
    return new_basename(old)[:-len('.ts')]


# Build rename table.
RENAMES = {p.name: new_basename(p.name) for p in SOURCES}
# old "<prefix>Identities" -> new "<domain>.identities" segment.
SEGMENT_MAP = {p.stem: f"{DOMAIN}.{stem_of(p.name)}" for p in SOURCES}


def move_files() -> None:
    MAIL_DIR.mkdir(exist_ok=True)
    for src in SOURCES:
        dst = MAIL_DIR / RENAMES[src.name]
        if dst.exists():
            print(f"skip move (exists): {dst.relative_to(REPO)}")
            continue
        print(f"move: {src.relative_to(REPO)} -> {dst.relative_to(REPO)}")
        shutil.move(str(src), str(dst))


def rewrite_internal_convex_imports() -> None:
    """Rewrite imports that reference the moved files.

    From files now inside mail/: `./mailX` (was `./mailX` at root) becomes
    `./newName` (sibling) — no, wait. Files are MOVED into mail/, so siblings
    that referenced via `./mailX` (root path) need different handling depending
    on where the IMPORTING file lives now.

    Cases (after move):
      - Importer in mail/X.ts importing a sibling mailY (now mail/y.ts):
        old `./mailY` -> `./y`
      - Importer in CONVEX/X.ts (root) importing mailY (now mail/y.ts):
        old `./mailY` -> `./mail/y`
      - Importer in CONVEX/lib/X.ts importing `../mailY` (was root):
        old `../mailY` -> `../mail/y`
      - Importer in CONVEX/lib/sub/X.ts importing `../../mailY`:
        old `../../mailY` -> `../../mail/y`
    """
    pattern = re.compile(rf"(from\s+['\"])((?:\.\.?/)+)({re.escape(PREFIX)}[A-Z][a-zA-Z0-9]*)(['\"])")

    for ts_file in CONVEX.rglob('*.ts'):
        if '_generated' in ts_file.parts:
            continue
        text = ts_file.read_text()
        new_text = text
        # Need to know the importer's location relative to CONVEX/mail/
        rel_to_convex = ts_file.parent.relative_to(CONVEX)

        def replace(m: re.Match) -> str:
            from_keyword = m.group(1)
            old_relative = m.group(2)
            old_module = m.group(3)
            quote = m.group(4)

            if old_module not in SEGMENT_MAP:
                # Reference to a mailX file we didn't move (shouldn't happen).
                return m.group(0)

            new_filename = SEGMENT_MAP[old_module].split('.')[-1]  # e.g. 'identities'

            # Resolve the source absolute (root file): old path was CONVEX/{old_module}.ts.
            # Build new path string from importer's perspective.
            target = MAIL_DIR / f"{new_filename}.ts"
            # importer dir = ts_file.parent
            try:
                from os.path import relpath
                rel = relpath(target, ts_file.parent)
            except ValueError:
                return m.group(0)
            # Strip .ts; ensure leading './' for sibling refs
            rel = rel[:-len('.ts')] if rel.endswith('.ts') else rel
            if not rel.startswith('.'):
                rel = './' + rel
            return f"{from_keyword}{rel}{quote}"

        new_text = pattern.sub(replace, new_text)

        if new_text != text:
            ts_file.write_text(new_text)
            print(f"rewrote internal imports in: {ts_file.relative_to(REPO)}")


def rewrite_api_internal_refs() -> None:
    """Rewrite api.<prefix>X.* and internal.<prefix>X.* across the entire repo."""
    pattern = re.compile(rf"\b(api|internal)\.({re.escape(PREFIX)}[A-Z][a-zA-Z0-9]*)\b")

    targets = []
    for ext in ('*.ts', '*.vue'):
        for p in REPO.rglob(ext):
            if 'node_modules' in p.parts:
                continue
            if '_generated' in p.parts:
                continue
            if '.nuxt' in p.parts or '.output' in p.parts or '.turbo' in p.parts:
                continue
            targets.append(p)

    rewritten = 0
    for ts_file in targets:
        text = ts_file.read_text()
        new_text = pattern.sub(
            lambda m: f"{m.group(1)}.{SEGMENT_MAP[m.group(2)]}"
            if m.group(2) in SEGMENT_MAP
            else m.group(0),
            text,
        )
        if new_text != text:
            ts_file.write_text(new_text)
            rewritten += 1
            print(f"rewrote api/internal refs in: {ts_file.relative_to(REPO)}")

    print(f"\nRewrote {rewritten} files for api/internal references.")


def main() -> None:
    if not SOURCES:
        print(f"No {PREFIX}*.ts files at convex/ root — nothing to move.")
    else:
        move_files()
    rewrite_internal_convex_imports()
    rewrite_api_internal_refs()
    print(f"\nNext: run `python3 fix_moved_imports.py {DOMAIN}` to fix the moved files' own ../ imports,")
    print(f"then `npx convex codegen` and `npx vitest run`.")


if __name__ == '__main__':
    main()
