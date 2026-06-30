#!/usr/bin/env python3
"""
Extract the Personal Mail (Postbox) tables from schema.ts into schema/mail.ts.

This is the working pattern for the per-domain schema split. Apply the same
shape to other contiguous table blocks (campaigns, contacts, automations,
agent, etc.) once this is verified.
"""

import re
from pathlib import Path

SCHEMA = Path('/Users/marcel/Code/WLS - wolves/owlat/apps/api/convex/schema.ts')
SCHEMA_DIR = SCHEMA.parent / 'schema'

# Marker for the start of the mail block (the section comment).
START_MARKER = '\t// ============================================================\n\t// Personal Mail (Postbox) Tables'
# Marker for the line after mail block ends.
END_MARKER = '\t// Knowledge Backfill Jobs - tracks one-time bulk extraction'


def main() -> None:
    SCHEMA_DIR.mkdir(exist_ok=True)
    text = SCHEMA.read_text()
    lines = text.split('\n')

    # Locate start: first line that begins the section comment block
    start_idx = None
    for i, line in enumerate(lines):
        if line.startswith('\t// =') and i + 1 < len(lines) and 'Personal Mail' in lines[i + 1]:
            start_idx = i
            break
    if start_idx is None:
        raise RuntimeError("Couldn't find Personal Mail section start")

    # Locate end: line of the next domain's leading comment
    end_idx = None
    for i in range(start_idx, len(lines)):
        if 'Knowledge Backfill Jobs' in lines[i] and lines[i].startswith('\t// '):
            end_idx = i
            break
    if end_idx is None:
        raise RuntimeError("Couldn't find post-mail boundary")

    # Capture the block, trimming trailing blank lines.
    while end_idx > start_idx and lines[end_idx - 1].strip() == '':
        end_idx -= 1
    block = lines[start_idx:end_idx]

    # Strip one tab of indentation (we're moving from inside defineSchema({...})
    # to the top level of an object literal in mail.ts).
    dedented = [line[1:] if line.startswith('\t') else line for line in block]

    # Replace the trailing comma after the last table's index chain. The block's
    # last non-blank line ends in `,` because it was an entry in the parent
    # object — that comma stays valid as the last entry in the new object too.

    mail_module = (
        "import { defineTable } from 'convex/server';\n"
        "import { v } from 'convex/values';\n"
        "\n"
        "/**\n"
        " * Personal Mail (Postbox) tables — Gmail-equivalent backend.\n"
        " *\n"
        " * Distinct from `inboundMessages`/`conversationThreads` which power the\n"
        " * AI-assisted shared support inbox (defined in schema.ts).\n"
        " *\n"
        " * Spread into `defineSchema()` from schema.ts via `...mailTables`.\n"
        " */\n"
        "export const mailTables = {\n"
        + '\n'.join(dedented)
        + "\n};\n"
    )

    (SCHEMA_DIR / 'mail.ts').write_text(mail_module)
    print(f"wrote: {SCHEMA_DIR / 'mail.ts'}")

    # Replace the original block in schema.ts with `\t...mailTables,`
    new_lines = lines[:start_idx] + ['\t...mailTables,'] + lines[end_idx:]
    new_text = '\n'.join(new_lines)

    # Add the import
    import_line = "import { mailTables } from './schema/mail';"
    if import_line not in new_text:
        # Insert after the existing imports block (before the first blank line after them)
        marker = "} from './lib/validators';\n"
        new_text = new_text.replace(marker, marker + import_line + '\n')

    SCHEMA.write_text(new_text)
    print(f"updated: {SCHEMA}")
    print(f"\nMoved {end_idx - start_idx} lines into schema/mail.ts")


if __name__ == '__main__':
    main()
