---
name: feature-implementation-and-integration
description: Workflow command scaffold for feature-implementation-and-integration in solana-jito-flash-searcher.
allowed_tools: ["Bash", "Read", "Write", "Grep", "Glob"]
---

# /feature-implementation-and-integration

Use this workflow when working on **feature-implementation-and-integration** in `solana-jito-flash-searcher`.

## Goal

Implements a new feature or module and integrates it with the main entry point.

## Common Files

- `src/flash_brain.ts`
- `src/index.ts`

## Suggested Sequence

1. Understand the current state and failure mode before editing.
2. Make the smallest coherent change that satisfies the workflow goal.
3. Run the most relevant verification for touched files.
4. Summarize what changed and what still needs review.

## Typical Commit Signals

- Create or update a new module file in src/
- Update src/index.ts to integrate the new module or feature

## Notes

- Treat this as a scaffold, not a hard-coded script.
- Update the command if the workflow evolves materially.