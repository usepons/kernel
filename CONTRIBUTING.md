# Contributing to @pons/kernel

Thanks for your interest in contributing to Pons!

## Getting Started

1. **Fork** the repository
2. **Clone** your fork locally
3. Make sure you have [Deno](https://deno.land) installed (v2+)

## Development

```bash
deno task dev              # Watch mode with auto-restart
deno task start            # Production mode
deno check src/index.ts    # Type check
```

## Making Changes

1. Create a feature branch from `main`:
   ```bash
   git checkout -b feat/my-feature
   ```

2. Make your changes — keep commits focused and atomic

3. Ensure your code passes type checking:
   ```bash
   deno check src/index.ts
   ```

4. Push your branch and open a Pull Request

## Code Style

- TypeScript, strict mode
- No external linter — Deno's built-in formatter and checker are the standard:
  ```bash
  deno fmt
  deno lint
  ```
- Explicit imports with `jsr:` or `npm:` prefixes and version constraints
- No bare specifiers

## Architecture Rules

- The kernel is **thin** — if it doesn't belong in the five core responsibilities (bus, lifecycle, RPC, service directory, config), it belongs in a module
- Modules communicate **only** through the kernel (pub/sub or RPC) — no direct imports between modules
- Every module runs as an **isolated child process**

## Pull Request Guidelines

- Keep PRs small and focused on a single concern
- Write a clear description of what changed and why
- Reference related issues if applicable

## Reporting Issues

Found a bug or have a feature request? [Open an issue](https://github.com/usepons/kernel/issues/new).

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
