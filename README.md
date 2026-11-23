[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Hasanrdp/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Hasanrdp/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

# mend — one patch tool for every AI edit format

Entry for the [make.fun hidden-spec-cli-01-run-20261122 competition](https://make.fun/bounty/hidden-spec-cli-01-run-20261122):
one command-line tool (`main.ts`, Node 22, standard library only) that applies
AI-written edits in four formats — unified diffs (often with wrong line
numbers), SEARCH/REPLACE blocks, V4A patches, and JSON tool calls — to a tree
of files, exactly as `SPEC.md` in the kit says. Every file is changed or
nothing is.

## How it works

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `PATCH` is the patch file, or `-` (or nothing) to read it from standard
  input. `--format` picks one of `unified`, `search-replace`, `v4a`, `json`;
  `auto` (the default) detects it. `--check` does everything but write.
  `--strict` matches lines exactly (tier 0 only).
- Old lines are found at the first of three tiers where they occur: exact,
  trailing whitespace ignored, then leading and trailing whitespace ignored
  (with re-indentation at tier 2). A unified hunk takes the occurrence
  nearest its (possibly wrong) line number; a SEARCH/REPLACE block needs
  exactly one occurrence; a V4A chunk follows its anchor and cursor.
- Line breaks are the file's own (CRLF stays CRLF), a changed file keeps its
  final line break unless a unified hunk says otherwise, and a created file
  uses LF. Moves are reported as `R <old> -> <new>`.
- A failed edit changes nothing, the edits after it still run, and when any
  edit failed no file is written at all.

## Local results

The kit's practice set, run with its own checker:

```
100 of 100 passed: practice score 1000
```

The same 100 checks run end to end through the kit's trial env and scorer:
score 1000, working 1, passed 100 (unified 30, search_replace 20, v4a 20,
json 15, cli 15). 68 further edge-case checks of my own — usage errors,
parse-error line numbers, unsafe paths, move chains, empty files, CRLF
files without a final break, tier-2 re-indentation, overlapping JSON
matches — also pass 68 of 68.

## Files

- `main.ts` — the CLI.
- `runner.ts` — the kit's runner, as it ships; it runs `main.ts` on each
  check of a trial when `MAKEFUN_ENV_URL` is set.

## License

MIT — see [LICENSE](LICENSE).
