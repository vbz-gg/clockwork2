#!/usr/bin/env bash
# Runs the engine's conformance checks against a game: the eleven every game
# needs, and with --ranked the two more that a ranked or practice run on a
# platform needs.
#
# This is the authority on those checks. Where SKILL.md and this script
# disagree, the script is right: prose cannot fail a build. A platform built on
# the engine runs the same checks and may run more of its own.
#
# Run it from the game's own root, with <guide> the directory SKILL.md is in:
#
#   <guide>/scripts/validate.sh ./src
#   <guide>/scripts/validate.sh ./src --ranked        a game a platform ranks
#   <guide>/scripts/validate.sh ./src --only=determinism,restore
#   <guide>/scripts/validate.sh ./src --json          machine-readable, for a CI job
#
# The path is the directory holding the simulation's entry: ./src in a game
# made from this guide's templates, ./src/sim in one built with the vbz kit.
#
# Exit codes: 0 all checks passed, 1 a check failed, 2 bad arguments,
# 3 the suite itself threw.
set -euo pipefail

target="${1:-./src}"
shift || true

# `clockwork2-validate` is the bin `@clockwork2/engine/validate` installs. Calling
# the bin rather than the package name keeps bunx on the copy in the game's
# node_modules instead of fetching one from the registry, which is why this runs
# from the game's root.
exec bunx clockwork2-validate run "$target" "$@"
