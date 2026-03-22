# Contributing to cc-mess

## Prerequisites

- Node.js 20+
- Claude Code installed

## Dev Setup

```bash
git clone https://github.com/yaniv-golan/cc-mess.git
cd cc-mess
npm install
npm run dev
```

## Coding Standards

- Strict TypeScript — no `any` (use `unknown` + type narrowing)
- Prefer named exports over default exports
- All public functions require JSDoc or self-documenting signatures
- Run `npm run lint` and `npm run typecheck` before committing

## Running Tests

```bash
npm run test          # Run all tests
npm run test:watch    # Watch mode
npm run test:coverage # Coverage report
```

## PR Process

1. Fork and create a feature branch from `main`
2. Write tests for new functionality
3. Ensure `npm run lint && npm run typecheck && npm run test` all pass
4. Submit a PR using the provided template
5. Address reviewer feedback

## Commit Message Format

Use conventional commits:

```
feat: add spawn depth enforcement
fix: handle stale lockfile on registry write
test: add concurrent spawn integration test
docs: update architecture diagram
```
