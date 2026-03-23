# @pons/kernel

The microkernel. No application logic — only process management, IPC routing, config, and security.

## Structure

```
src/
├── kernel.ts              # Main Kernel class — boot/start/shutdown orchestration
├── lifecycle.ts           # LifecycleManager — spawns modules, health checks, IPC routing
├── module-call-handler.ts # Handles all kernel API calls from modules
├── signal-handlers.ts     # SIGUSR1 (config reload), SIGUSR2 (perm reload), SIGHUP (module reload)
├── cli.ts                 # CLI entry — delegates to cli/ subcommands
├── cli/
│   ├── kernel-commands.ts # start, stop, restart, status, logs
│   ├── module-commands.ts # list, install, approve, uninstall, update
│   ├── gateway.ts         # Gateway connection helpers for CLI
│   └── utils.ts           # formatUptime, todayStamp, sleep
├── config/
│   ├── manager.ts         # ConfigManager — schema discovery, CRUD, validation
│   ├── schema-discovery.ts # Discovers Zod schemas from module configSchema files
│   └── diagnostics.ts     # ConfigDoctor — diagnose/fix config issues
├── module/
│   ├── loader.ts          # ModuleLoader — discovers modules from ~/.pons/modules/
│   └── registry.ts        # Module registry types
├── messaging/
│   └── bus.ts             # MessageBus — in-memory pub/sub
├── security/
│   ├── enforcer.ts        # SecurityEnforcer — runtime IPC permission checks
│   ├── permissions.ts     # PermissionStore — YAML-backed permission persistence
│   ├── types.ts           # Permission types and interfaces
│   ├── validation.ts      # modulePermissionsSchema (Zod)
│   ├── deno-flags.ts      # translateToDenoFlags() — manifest perms to --allow-* flags
│   ├── manifest-hash.ts   # Tamper detection via SHA-256 manifest hashing
│   └── constants.ts       # Shared security constants
├── process/
│   ├── process-forker.ts  # Forks module child processes with correct flags
│   └── child-process-wrapper.ts # Deno child process abstraction
├── ipc/
│   └── validation.ts      # IPC message validation
└── utils/
    └── fs.ts              # existsSync helper
```

## Key Concepts

**Module lifecycle**: discover -> spawn (Deno.Command with piped stdio) -> init (send config) -> ready (module declares manifest) -> deps_ready (all required services available) -> running -> shutdown

**Health checks**: ping every 30s, pong expected within 10s. 3 consecutive failures -> kill + restart. Exponential backoff: 1s base, 60s max, 5 max restarts.

**Config hot-reload (SIGUSR1)**: re-read config.yaml, validate, push `config:update` to affected modules, restart modules whose `configDependencies` sections changed.

**Permission hot-reload (SIGUSR2)**: re-read permissions.yaml, diff against current, restart modules with changed effective permissions.

**Module hot-swap (SIGHUP)**: re-discover modules, kill removed, spawn new.

## IPC Protocol

Transport: stdin/stdout, newline-delimited JSON. See `sdk/src/ipc-protocol.ts` for full types.

Kernel -> Module: `init`, `deliver`, `ping`, `shutdown`, `call`, `call:response`, `rpc_request`, `rpc_response`, `config:update`, `deps_ready`, `service_available`, `install`

Module -> Kernel: `ready`, `log`, `publish`, `call`, `call:response`, `rpc_request`, `rpc_response`, `pong`
