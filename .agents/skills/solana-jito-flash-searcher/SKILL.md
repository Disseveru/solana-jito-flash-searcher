# solana-jito-flash-searcher Development Patterns

> Auto-generated skill from repository analysis

## Overview

This skill outlines the core development practices for the `solana-jito-flash-searcher` TypeScript codebase. It covers file organization, code style, and the main workflows for implementing features and updating configuration or documentation. The repository is focused on Solana blockchain searcher logic, with modular code and clear integration points.

## Coding Conventions

- **File Naming:**  
  Use `kebab-case` for file names.  
  _Example:_  
  ```
  src/calculate-arb.ts
  ```

- **Import Style:**  
  Use relative imports with `.js` extensions for modules within the project.  
  _Example:_  
  ```typescript
  import { calculateArb } from './calculate-arb.js';
  ```

- **Export Style:**  
  Prefer named exports.  
  _Example:_  
  ```typescript
  // In src/calculate-arb.ts
  export function calculateArb(...) { ... }
  ```

- **Commit Messages:**  
  Freeform, no strict prefix, average length ~70 characters.

## Workflows

### Feature Implementation and Integration
**Trigger:** When adding a new feature or major module  
**Command:** `/feature-implementation-and-integration`

1. Create or update a module file in `src/` (e.g., `src/calculate-arb.ts`).
2. Implement the new feature using TypeScript and follow the coding conventions.
3. Integrate the new module by updating `src/bot.ts`:
   ```typescript
   import { calculateArb } from './calculate-arb.js';
   // Use the new feature here
   ```
4. Commit your changes with a descriptive message.

---

### Configuration and Documentation Update
**Trigger:** When adding/changing environment variables, modes, or clarifying documentation  
**Command:** `/configuration-and-documentation-update`

1. Update `.env.example` to reflect new or changed environment variables.
   ```
   # .env.example
   NEW_FEATURE_ENABLED=true
   ```
2. Update `README.md` to document new features or configuration options.
3. Update related config or entry files (e.g., `src/config.ts`, `src/bot.ts`) to support the new settings.
   ```typescript
   // In src/config.ts
   export const NEW_FEATURE_ENABLED = process.env.NEW_FEATURE_ENABLED === 'true';
   ```
4. Commit your changes with a message summarizing the update.

## Testing Patterns

- **Current State:**  
  No test files were detected in the repository.
- **Framework:**  
  No test framework or `test` script was detected in `package.json`.
- **Naming Convention:**  
  There is no established test file naming convention documented yet.
- **Guidance for Future Additions:**  
  If you add tests, also add the corresponding test runner configuration and a `test` script in `package.json`, then document the chosen file naming pattern.

## Commands

| Command | Purpose |
|---|---|
| /feature-implementation-and-integration | Start a new feature/module and integrate it into the entrypoint |
| /configuration-and-documentation-update | Update configuration examples and documentation |
