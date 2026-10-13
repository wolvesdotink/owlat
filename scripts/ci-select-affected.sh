#!/usr/bin/env bash
# Keep the local/Actions entry point; selection and grouping are tested in TS.
set -euo pipefail
cd "$(dirname "$0")/.."
exec bun scripts/ci/select.ts
