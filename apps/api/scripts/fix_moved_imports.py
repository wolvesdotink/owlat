#!/usr/bin/env python3
"""
Fix relative imports inside files that were moved into apps/api/convex/<domain>/.

The earlier `migrate_domain.py` adjusted cross-file references but didn't fix
the moved files' OWN imports of `./lib/X`, `./_generated/Y`, `./helperZ` —
those now need `../` prefix because the files are one level deeper.

Also fixes dynamic imports: `import('./_generated/api')` and type-only
imports: `import('./_generated/dataModel').Id<...>`.

Usage:
    python3 fix_moved_imports.py <domain>
"""

import re
import sys
from pathlib import Path

DOMAIN = sys.argv[1] if len(sys.argv) > 1 else 'mail'
MAIL_DIR = Path(f'/Users/marcel/Code/WLS - wolves/owlat/apps/api/convex/{DOMAIN}')

# Match: from './something' or from '../something'
IMPORT_RE = re.compile(r"(from\s+['\"])(\.\.?/)([^'\"]+)(['\"])")
DYNAMIC_IMPORT_RE = re.compile(r"(import\(['\"])(\.\.?/)([^'\"]+)(['\"]\))")


def fix(file_path: Path) -> bool:
    text = file_path.read_text()
    new_text = text

    def replace(m: re.Match) -> str:
        from_kw = m.group(1)
        relative = m.group(2)
        rest = m.group(3)
        quote = m.group(4)

        if relative == './':
            sibling = MAIL_DIR / (rest if rest.endswith('.ts') else rest + '.ts')
            sibling_dir = MAIL_DIR / rest
            if sibling.exists() or sibling_dir.exists():
                return m.group(0)
            return f"{from_kw}../{rest}{quote}"

        if relative == '../':
            return f"{from_kw}../../{rest}{quote}"

        return m.group(0)

    def replace_dynamic(m: re.Match) -> str:
        prefix_kw = m.group(1)
        relative = m.group(2)
        rest = m.group(3)
        suffix = m.group(4)
        if relative == './':
            sibling = MAIL_DIR / (rest if rest.endswith('.ts') else rest + '.ts')
            if sibling.exists():
                return m.group(0)
            return f"{prefix_kw}../{rest}{suffix}"
        if relative == '../':
            return f"{prefix_kw}../../{rest}{suffix}"
        return m.group(0)

    new_text = IMPORT_RE.sub(replace, new_text)
    new_text = DYNAMIC_IMPORT_RE.sub(replace_dynamic, new_text)

    if new_text != text:
        file_path.write_text(new_text)
        print(f"fixed: {file_path.relative_to(MAIL_DIR.parent.parent.parent.parent)}")
        return True
    return False


def main() -> None:
    if not MAIL_DIR.exists():
        print(f"Domain folder not found: {MAIL_DIR}")
        sys.exit(1)
    count = 0
    for ts in sorted(MAIL_DIR.glob('*.ts')):
        if fix(ts):
            count += 1
    print(f"\n{count} files fixed.")


if __name__ == '__main__':
    main()
