#!/usr/bin/env bash
# Runs the conformance suite against a game.
#
# This is the authority. Where SKILL.md and this script disagree, the script
# is right: it is what the platform runs, and prose cannot fail a build.
#
#   scripts/validate.sh ./src
#   scripts/validate.sh ./src --only=determinism,restore
#   scripts/validate.sh ./src --json          machine-readable, for a CI job
#
# Exit codes: 0 all checks passed, 1 a check failed, 2 bad arguments,
# 3 the suite itself threw.
set -euo pipefail

target="${1:-./src}"
shift || true

# `clockwork2-validate` is the bin `@clockwork2/validate` installs. Calling
# the bin rather than the package name keeps bunx on the copy in the game's
# node_modules instead of fetching one from the registry.
exec bunx clockwork2-validate run "$target" "$@"
