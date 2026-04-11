```markdown
# solana-jito-flash-searcher Development Patterns

> Auto-generated skill from repository analysis

## Overview

This skill outlines the core development practices for the `solana-jito-flash-searcher` TypeScript codebase. It covers file organization, code style, and the main workflows for implementing features and updating configuration or documentation. The repository is focused on Solana blockchain searcher logic, with modular code and clear integration points.

## Coding Conventions

- **File Naming:**  
  Use `camelCase` for file names.  
  _Example:_  
  ```
  src/flashBrain.ts
  ```

- **Import Style:**  
  Use relative imports for modules within the project.  
  _Example:_  
  ```typescript
  import { searchFlash } from './flashBrain';
  ```

- **Export Style:**  
  Prefer named exports.  
  _Example:_  
  ```typescript
  // In src/flashBrain.ts
  export function searchFlash() { ... }
  ```

- **Commit Messages:**  
  Freeform, no strict prefix, average length ~70 characters.

## Workflows

### Feature Implementation and Integration
**Trigger:** When adding a new feature or major module  
**Command:** `/add-feature`

1. Create or update a module file in `src/` (e.g., `src/flashBrain.ts`).
2. Implement the new feature using TypeScript and follow the coding conventions.
3. Integrate the new module by updating `src/index.ts`:
   ```typescript
   import { searchFlash } from './flashBrain';
   // Use the new feature here
   ```
4. Commit your changes with a descriptive message.

---

### Configuration and Documentation Update
**Trigger:** When adding/changing environment variables, modes, or clarifying documentation  
**Command:** `/update-docs-config`

1. Update `.env.example` to reflect new or changed environment variables.
   ```
   # .env.example
   NEW_FEATURE_ENABLED=true
   ```
2. Update `README.md` to document new features or configuration options.
3. Update related config or entry files (e.g., `src/config.ts`, `src/index.ts`) to support the new settings.
   ```typescript
   // In src/config.ts
   export const NEW_FEATURE_ENABLED = process.env.NEW_FEATURE_ENABLED === 'true';
   ```
4. Commit your changes with a message summarizing the update.

## Testing Patterns

- **Test File Naming:**  
  Test files follow the pattern `*.test.*` (e.g., `flashBrain.test.ts`).
- **Framework:**  
  Not explicitly detected—review or add tests as needed.
- **Example:**  
  ```typescript
  // flashBrain.test.ts
  import { searchFlash } from './flashBrain';

  test('searchFlash returns expected results', () => {
    expect(searchFlash()).toBeDefined();
  });
  ```

## Commands

| Command          | Purpose                                                        |
|------------------|----------------------------------------------------------------|
| /add-feature     | Start a new feature/module and integrate it into the entrypoint|
| /update-docs-config | Update configuration examples and documentation             |
```