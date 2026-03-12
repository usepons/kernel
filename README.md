<p align="center">
  <img src="logo/mono.svg" width="80" alt="Pons logo" />
</p>

<h3 align="center">@pons/kernel</h3>

<p align="center">
  The microkernel that orchestrates Pons modules.<br/>
  <i>The smallest seed of a thinking system.</i>
</p>

<p align="center">
  <a href="https://jsr.io/@pons/kernel"><img src="https://jsr.io/badges/@pons/kernel" alt="JSR" /></a>
  <a href="https://deno.land"><img src="https://img.shields.io/badge/runtime-Deno-000?logo=deno" alt="Deno" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/usepons/kernel?color=blue" alt="MIT License" /></a>
  <a href="https://github.com/usepons/kernel/stargazers"><img src="https://img.shields.io/github/stars/usepons/kernel?style=flat" alt="Stars" /></a>
  <a href="https://github.com/usepons/kernel/network/members"><img src="https://img.shields.io/github/forks/usepons/kernel?style=flat" alt="Forks" /></a>
  <a href="https://github.com/usepons/kernel/issues"><img src="https://img.shields.io/github/issues/usepons/kernel" alt="Issues" /></a>
</p>

---

## What it does

The kernel is a thin process orchestrator. It has five responsibilities — and only these:

- **Message Bus** — in-memory pub/sub forwarding between modules. No persistence, no queue. Fire-and-forget.
- **Module Lifecycle** — spawn, kill, restart, hot-swap. Each module runs as an isolated child process.
- **RPC Routing** — direct IPC routing for request/response between modules, with timeouts and origin validation.
- **Service Directory** — dynamic discovery of module-provided services via `provides`/`requires` declarations.
- **Configuration** — layered YAML config with schema validation, hot-reload via `SIGUSR1`, and per-module config sections.

Everything else lives in modules.

## Architecture

```
┌─────────────────────────────────────────────┐
│                   Kernel                     │
│                                              │
│  ┌───────────┐  ┌──────────┐  ┌───────────┐ │
│  │ Message   │  │ Lifecycle│  │  Service   │ │
│  │ Bus       │  │ Manager  │  │  Directory │ │
│  └─────┬─────┘  └────┬─────┘  └─────┬─────┘ │
│        │             │               │       │
└────────┼─────────────┼───────────────┼───────┘
         │             │               │
    ┌────┴──┐    ┌─────┴──┐    ┌──────┴──┐
    │ Agent │    │  LLM   │    │ Gateway │    ...modules
    │       │    │        │    │         │
    └───────┘    └────────┘    └─────────┘
      process      process       process
```

Modules never import each other. All communication flows through the kernel via IPC.

## Installation

The recommended way to install Pons is via the CLI:

```bash
deno install -gA jsr:@pons/cli
```

Then start the kernel:

```bash
pons start
```

### Standalone kernel

If you need just the kernel without the CLI:

```bash
deno install -gA -n pons-kernel jsr:@pons/kernel
```

```bash
pons-kernel                    # start
pons-kernel --log debug        # verbose logging
pons-kernel -d                 # daemon mode
```

## Core Concepts

### Message Bus

Modules communicate through topics. A module declares which topics it subscribes to in its manifest, and publishes messages to any topic.

```
Module A  ──publish("llm:generate", payload)──▶  Kernel  ──deliver──▶  Module B
```

The bus is pure routing — no persistence, no retry. If a module needs delivery guarantees, it implements them itself.

### RPC

For request/response patterns, modules use RPC through the kernel's service directory:

```
Agent  ──rpc_request(service: "providerRegistry", method: "generate")──▶  Kernel  ──▶  LLM
       ◀──rpc_response(result)──────────────────────────────────────────  Kernel  ◀──  LLM
```

The kernel resolves the service name to a module ID, forwards the request, and routes the response back. Timeout: 30s.

### Module Lifecycle

1. Kernel discovers modules from `~/.pons/modules/`
2. Each module is spawned as a child process with its own `deno.json`
3. Module sends `ready` → kernel checks `requires` dependencies
4. When all required services are available → kernel sends `deps_ready`
5. Health checks run every 30s via `ping`/`pong`
6. On crash: exponential backoff restart (max 5 attempts)

### Configuration

Layered YAML config at `~/.pons/config.yaml`:

```yaml
logging:
  level: info
  levels:
    agent: debug

models:
  providers:
    - id: anthropic
      type: anthropic
```

Modules declare a `configKey` in their manifest. When that section changes, the kernel pushes `config:update` to the module. Hot-reload: send `SIGUSR1` to the kernel process.

## Module Manifest

Every module has a `module.json`:

```json
{
  "id": "llm",
  "name": "LLM Services",
  "description": "Provider registry, model routing, cost tracking",
  "provides": ["providerRegistry", "model-router", "cost-tracker"],
  "subscribes": ["llm:generate", "llm:stream:request"],
  "requires": [],
  "optionalRequires": ["http-router"],
  "configKey": "models",
  "configSchema": "./src/config.schema.ts",
  "priority": 5
}
```

| Field | Description |
|-------|-------------|
| `id` | Unique module identifier |
| `provides` | Services this module exposes for RPC |
| `subscribes` | Bus topics this module listens to |
| `requires` | Services that must be available before activation |
| `optionalRequires` | Services the module can use but doesn't need to start |
| `configKey` | Top-level config section this module owns |
| `configSchema` | Path to Zod schema for config validation |
| `priority` | Spawn order (lower = earlier) |

## Kernel API

Built-in methods available to modules via `call`:

| Method | Params | Returns |
|--------|--------|---------|
| `config.get` | `{ key: string }` | Config value |
| `config.set` | `{ key: string, value: unknown }` | `{ success: boolean }` |
| `config.sections` | — | Available config sections |
| `module.list` | — | All registered modules |
| `module.commands` | — | CLI commands from modules |
| `service.discover` | — | All registered services |
| `service.resolve` | `{ service: string }` | Module ID providing the service |

## Project Structure

```
src/
├── index.ts              # Entry point — CLI flags, boot, start
├── kernel.ts             # Kernel class: boot/start/shutdown
├── lifecycle.ts          # Spawn/kill/hot-swap, RPC routing, health checks
├── messaging/
│   └── bus.ts            # In-memory pub/sub registry
├── module/
│   ├── loader.ts         # Module discovery from filesystem
│   └── registry.ts       # Module tracking + service directory
├── config/
│   ├── manager.ts        # Config CRUD, schema discovery, validation
│   └── types.ts          # Config types
├── logs/
│   └── logger.ts         # Logger factory + module log forwarding
└── formatters.ts         # Shared formatting utilities
```

## Development

```bash
deno task dev              # Watch mode
deno task start            # Production
deno check src/index.ts    # Type check
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

[MIT](LICENSE)
