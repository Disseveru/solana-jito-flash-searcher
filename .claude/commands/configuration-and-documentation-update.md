---
name: configuration-and-documentation-update
description: Workflow command scaffold for configuration-and-documentation-update in solana-jito-flash-searcher.
allowed_tools: ["Bash", "Read", "Write", "Grep", "Glob"]
---

# /configuration-and-documentation-update

Use this workflow when working on **configuration-and-documentation-update** in `solana-jito-flash-searcher`.

## Goal

Updates configuration examples and documentation, often alongside code changes for new features or modes.

## Common Files

- `.env.example`
- `README.md`
- `src/config.ts`
- `src/bot.ts`

## Suggested Sequence

1. Understand the current state and failure mode before editing.
2. Make the smallest coherent change that satisfies the workflow goal.
3. Run the most relevant verification for touched files.
4. Summarize what changed and what still needs review.

## Typical Commit Signals

- Update .env.example to reflect new or changed environment variables
- Update README.md to document new features or configuration options
- Update related config or entry files to support the new settings

## Notes

- Treat this as a scaffold, not a hard-coded script.
- Update the command if the workflow evolves materially.
