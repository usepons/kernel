# Pons Kernel — Specification

> Version: 1.0
> Status: Active

---

## 1. Purpose

The Pons Kernel is a microkernel — the single orchestration point of the system. Its responsibility is strictly limited to five things:

1. **Message Bus** — pub/sub between modules (in-memory, fire-and-forget)
2. **Lifecycle Manager** — spawn, kill, restart, hot-swap of module processes
3. **RPC Routing** — request/response routing between modules with timeout enforcement
4. **Service Directory** — dynamic resolution of who provides what, circular dependency detection
5. **Configuration** — layered config with schema validation, hot-reload, scoped per module

Everything else lives in modules. The kernel contains no business logic.

---

## 2. Boot Sequence

This is the complete step-by-step sequence from `pons kernel start` to "system ready".

```
Phase 1 — Discovery
  1. Read kernel manifest (version, metadata)
  2. Scan <home>/.pons/modules/ for module directories
  3. For each directory:
     a. Read module.json
     b. Validate: id, name, permissions block present
     c. Verify manifest hash against stored hash (tamper detection)
     d. Resolve entry point path (must exist within module dir)
     e. Skip invalid modules with logged reason
  4. Result: list of DiscoveredModules

Phase 2 — Configuration
  5. For each discovered module with a configSchema:
     a. Import/load the schema file
     b. Security check: schema path must be within module directory
  6. Merge all module schemas + kernel schema → unified AppSchema
  7. Load <home>/.pons/config.yaml
  8. Validate config against AppSchema
  9. Fill missing values with schema defaults
  10. If config is invalid: log warnings, continue with best-effort values

Phase 3 — Module Spawn
  11. Sort modules by priority (lower = first)
  12. For each module:
      a. Read approved permissions from PermissionStore
      b. Read approved capabilities from PermissionStore
      c. Construct spawn command based on runtime (see Section 21)
      d. Spawn child process
      e. Send { type: "init", protocolVersion, config, workspacePath, projectRoot }
      f. Wait for { type: "ready" } (max 30s)
      g. On ready: validate manifest, register services, check circular deps
      h. If required services available: send { type: "deps_ready" }, start health checks
      i. If required services missing: hold in "waiting" state
  13. Cascade: as services become available, activate waiting modules

Phase 4 — Running
  14. Register signal handlers (SIGINT, SIGTERM, SIGUSR1, SIGUSR2, SIGHUP)
  15. Write PID to <home>/.pons/.runtime/kernel.pid
  16. Emit kernel.boot log event
  17. System is ready — message bus active, RPC routing active
```

---

## 3. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         Kernel                              │
│                                                             │
│  ┌────────────┐  ┌──────────────┐  ┌────────────────────┐  │
│  │ MessageBus │  │  Lifecycle   │  │  ServiceDirectory  │  │
│  │ (pub/sub)  │  │  Manager     │  │  (registry)        │  │
│  └────────────┘  └──────────────┘  └────────────────────┘  │
│  ┌────────────┐  ┌──────────────┐  ┌────────────────────┐  │
│  │  Config    │  │  Permission  │  │  Security          │  │
│  │  Manager   │  │  Store       │  │  Enforcer          │  │
│  └────────────┘  └──────────────┘  └────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
         │ IPC (newline-delimited JSON over stdin/stdout)
    ┌────┴────┬─────────┬──────────┬───────────┐
    │         │         │          │           │
 module-   module-  module-   module-    module-...
 agent      llm     gateway   memory     sandbox
 (process) (process)(process) (process) (process)
```

**Core principle:** modules never import each other. All communication flows through the kernel over IPC.

---

## 4. IPC Protocol

### Transport

Newline-delimited JSON over stdin/stdout of each child process. One JSON object per line, terminated by `\n`. No binary framing, no external message broker required.

### Kernel → Module messages

| type | Fields | Description |
|------|--------|-------------|
| `init` | `protocolVersion`, `config`, `workspacePath`, `projectRoot` | First message after spawn. Delivers protocol version and initial config. |
| `install` | — | Signals first-ever launch. Module should declare any permission requests. |
| `deps_ready` | — | All required services are available. Module may begin full operation. |
| `shutdown` | — | Graceful shutdown request. Module should clean up and exit. |
| `ping` | — | Health check. Module must reply with `pong` within the timeout. |
| `deliver` | `id`, `topic`, `payload` | Pub/sub message delivery. |
| `config:update` | `config`, `changedSections` | Config hot-reload. Contains only the module's own section. |
| `call` | `id`, `method`, `params` | Kernel calling a method on the module. |
| `rpc_request` | `id`, `from`, `service`, `method`, `params` | Proxied RPC request from another module. |
| `rpc_response` | `id`, `result?`, `error?` | Response to a previously sent RPC request. |
| `service_available` | `service` | An optional dependency just became available. |

### Module → Kernel messages

| type | Fields | Description |
|------|--------|-------------|
| `ready` | `manifest`, `capabilities?` | Module has initialized and is ready. Sends its parsed manifest and optionally its capabilities for kernel validation. |
| `log` | `level`, `msg`, `data?`, `topic?` | Structured log entry to be aggregated by the kernel. Optional `topic` enables log grouping (e.g. `agent:loop`). |
| `log-group` | `level`, `msg`, `items` | Grouped log entries (e.g. a summary with sub-items). |
| `publish` | `topic`, `payload` | Publish a message to the bus. |
| `call` | `id`, `method`, `params` | Call a method on the kernel (config.get, module.list, etc.). |
| `call:response` | `id`, `result?`, `error?` | Response to a kernel call. |
| `pong` | — | Reply to a `ping` health check. |
| `rpc_request` | `id`, `service`, `method`, `params` | Initiate an RPC call to another module. |
| `rpc_response` | `id`, `result?`, `error?` | Response to a proxied RPC request. |
| `ack` | `id` | Acknowledge successful processing of a `deliver` message. `id` matches the delivered message. |
| `nack` | `id`, `error` | Reject a `deliver` message. `error` is a human-readable string describing the failure. Informational only — kernel does not retry. |

---

## 5. RPC Flow

```
Caller Module              Kernel                 Target Module
     │                       │                         │
     ├──rpc_request(id)─────>│                         │
     │  service, method,      │                         │
     │  params                │                         │
     │                        ├─ capability check       │
     │                        ├─rpc_request(id)────────>│
     │                        │  from, method, params   │
     │                        │                         │ (processing)
     │                        │<──rpc_response(id)──────│
     │<─rpc_response(id)──────│  result / error         │
     │  result / error        │                         │
```

**Timeout:** 30 seconds. On expiry — error response is sent back to the caller.

---

## 6. Pub/Sub Flow

```
Publisher              Kernel                    Subscribers
    │                   │                        │    │    │
    ├─publish(topic)───>│                        │    │    │
    │  payload           ├─deliver(id, topic)───>│    │    │
    │                   │  payload               │    │    │
    │                   ├─deliver(id, topic)──────────>│    │
    │                   ├─deliver(id, topic)──────────────>│
```

Fire-and-forget. No persistence, no retry. The `ack`/`nack` messages defined in the IPC protocol (Section 4) exist for module-to-module application-level tracking — the kernel forwards them but does not use them for delivery guarantees or retry logic. Stronger guarantees (at-least-once, persistence, replay) are the responsibility of modules.

### Module Lifecycle Events

The kernel publishes lifecycle events to the message bus whenever a module changes state. This allows modules to react to system topology changes without polling.

| Topic | Payload | Published when |
|-------|---------|----------------|
| `system:module:ready` | `{ moduleId, provides, version }` | Module activated and health checks started |
| `system:module:stopped` | `{ moduleId, reason }` | Module intentionally stopped (shutdown, kill) |
| `system:module:crashed` | `{ moduleId, exitCode, restartCount }` | Module exited unexpectedly, entering restart flow |
| `system:module:stopping` | `{ moduleId, tier }` | Module is about to receive shutdown signal (during ordered drain) |

**Rules:**
- These are published by the kernel itself, not by modules
- They follow the same delivery semantics as all pub/sub — at-most-once, fire-and-forget
- Modules must declare `system:module:*` topics in their `capabilities.topics` to receive them
- The kernel publishes these **after** the state transition is complete (e.g. `system:module:ready` is sent after the module's services are registered, not before)
- During shutdown, `system:module:stopping` is sent **before** the `shutdown` message to the target module, giving other modules a chance to stop sending work to it

**Use cases:**
- Gateway can show real-time system status to connected clients
- Monitoring modules can track uptime and crash frequency
- Modules with optional dependencies can react to services appearing/disappearing beyond the built-in `service_available` mechanism

---

## 7. Module Lifecycle

### State Machine

Every module has exactly one status at any given time. Transitions are triggered by events from the module process, the kernel, or external signals.

```
                          spawn()
                            │
                            ▼
                      ┌──────────┐
                      │ starting │
                      └────┬─────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
         ready msg    timeout 30s    crash/exit
              │            │            │
              ▼            ▼            ▼
        ┌──────────┐  ┌────────┐  ┌─────────────┐
        │ waiting  │  │ killed │  │ restarting  │◄──┐
        │ (deps)   │  └────────┘  └──────┬──────┘   │
        └────┬─────┘                     │           │
             │                    backoff delay      │
        deps ready                       │           │
             │                      spawn()          │
             ▼                           │           │
       ┌──────────┐                      └───────────┘
       │  ready   │                  (max 5 attempts)
       └────┬─────┘                         │
            │                               ▼
       ┌────┼────────┐              ┌──────────────┐
       │    │        │              │   crashed    │
   crash  kill()  shutdown          │ (terminal)   │
       │    │        │              └──────────────┘
       ▼    ▼        ▼
  restarting stopped stopped
```

**States:**

| State | Description |
|-------|-------------|
| `starting` | Process spawned, waiting for `ready` message (max 30s) |
| `waiting` | Module sent `ready` but required services are not yet available (max 30s) |
| `ready` | Module is fully operational. Health checks are active. |
| `restarting` | Module exited unexpectedly. Kernel is waiting for backoff delay before re-spawning. |
| `stopped` | Module was intentionally stopped (shutdown or kill). |
| `crashed` | Module exceeded max restart attempts. Terminal state — requires manual intervention. |
| `killed` | Module was killed due to a violation or timeout. May lead to restart or stopped. |

**Transition rules:**
- Only `ready` modules receive `deliver`, `rpc_request`, and `config:update` messages
- A module in `waiting` only receives `service_available` notifications
- A module in `crashed` state can only be restarted manually via `pons module restart <id>`
- `killed` is a transient state — it transitions to `restarting` (if attempts remain) or `crashed`

The full activation sequence is described in Section 2 (Boot Sequence, Phase 3).

### Health Checks

- Every **30 seconds**: kernel sends `ping`
- Module must reply with `pong` within **10 seconds**
- After **3 consecutive failures**: kill process → restart logic
- A single successful `pong` resets the failure counter

### Crash & Restart

- Exponential backoff: 1s → 2s → 4s → 8s → 16s → 32s → 60s (max)
- Maximum **5 attempts**
- If module lived less than 1 second → likely an entry point error (logged as warning)
- After 5 failed attempts → status: `crashed`, no further restarts
- Restart counter resets if module stays alive for more than 60 seconds

### Hot-Swap

Hot-swap replaces a running module with a new version without restarting the kernel or other modules.

```
1. CLI or operator triggers hot-swap for module X
2. Kernel sends { type: "shutdown" } to module X
3. Wait up to 5s for graceful exit
4. Kill if still running
5. Unregister module X's services from the directory
6. Load new manifest from disk (re-read module.json)
7. Validate new manifest (hash, permissions, entry point)
8. Spawn new process with updated permissions
9. Wait for ready → re-register services
10. Notify modules that had optional dependency on X's services
```

**Constraints:**
- Hot-swap does not change the module ID — it's the same logical module with new code
- If the new version fails to start, the old version is NOT restored (module enters restart/crash flow)
- In-flight RPC calls to the old module will timeout and return errors to callers

### Graceful Shutdown (Ordered Drain)

The kernel shuts down modules in reverse dependency order to ensure clean drain of in-flight work. Modules that accept external traffic (e.g. gateway) stop first, allowing downstream modules (e.g. agent, LLM) to finish processing before they are stopped.

```
Phase 1 — Compute shutdown order
  1. Build dependency graph from all running modules' `requires` and `provides`
  2. Topological sort: modules with no dependents (leaves) shut down first
  3. Group into tiers — modules in the same tier can shut down in parallel

Phase 2 — Tier-by-tier shutdown
  For each tier (leaves first → roots last):
    1. Kernel publishes { topic: "system:module:stopping", payload: { moduleId, tier } }
       to the bus (allows other modules to stop sending work to this module)
    2. Kernel → modules in tier: { type: "shutdown" }
    3. Wait up to 5 seconds for voluntary exit
    4. Kill remaining processes in this tier forcefully
    5. Proceed to next tier

Phase 3 — Cleanup
  1. Close message bus
  2. Remove kernel PID file
  3. Close log file handle
  4. Exit kernel process
```

**Example shutdown order:**

```
Tier 1 (leaves — no one depends on them):  module-gateway
Tier 2 (depended on by gateway only):      module-agent, module-sandbox
Tier 3 (depended on by agent):             module-llm, module-memory
```

Gateway stops accepting connections first. Agent finishes in-flight turns. LLM and memory stop last after all consumers are gone.

**Fallback:** if the dependency graph is empty or cannot be computed (e.g. no `requires` declared), the kernel falls back to sending `shutdown` to all modules simultaneously (v1 behavior).

---

## 8. Service Directory

Each module declares in its manifest:

```json
{
  "provides": ["service-name"],
  "requires": ["other-service"],
  "optionalRequires": ["nice-to-have-service"]
}
```

**Rules:**
- Each service name may only be provided by **one** module (duplicates are rejected)
- `requires` — module will not activate until all required services are available (timeout: 30s)
- `optionalRequires` — graceful degradation; module activates even without them, and receives a `service_available` notification if they come online later
- Circular dependency detection runs on every activation (DFS graph traversal); a detected cycle kills the module immediately

### Topic Subscription

Topics are the pub/sub channel names used for fire-and-forget messaging. Subscription is **declared statically** in the module manifest via `capabilities.topics`:

```json
{
  "capabilities": {
    "topics": ["inbound:message", "agent:turn:end"]
  }
}
```

When a module sends `{ type: "ready" }`, the kernel reads the `capabilities.topics` list and registers the module as a subscriber for those topics in the MessageBus.

**Rules:**
- A module can only publish to topics listed in its `capabilities.topics` — enforced by the SecurityEnforcer
- A module can only receive `deliver` messages for topics it declared
- There is no dynamic subscribe/unsubscribe at runtime in v1. Changing topic subscriptions requires a manifest update and module restart (or hot-swap).
- Topic names are freeform strings. Convention: `domain:event` (e.g. `agent:turn:start`, `outbound:ws`)

---

## 9. Kernel Call API (Module → Kernel)

A module calls the kernel by sending a `call` message. The kernel responds with `call:response`.

| method | Params | Returns | Description |
|--------|--------|---------|-------------|
| `config.get` | `{ key }` | value | Read a value from the module's own config section. Key is a dot-separated path (e.g. `"agents.defaultModel"`). |
| `config.set` | `{ key, value }` | `{ ok: true }` | Write a value to the module's own config section. Validates against schema. Persists to config.yaml atomically. Notifies affected modules via `config:update`. |
| `config.sections` | — | list of strings | List available config section names (filtered to the module's own section only). |
| `module.list` | — | list of `{ id, status, provides }` | Get all modules with their current status and provided services. |
| `module.commands` | — | list of CommandDeclarations | Get all CLI command declarations from all module manifests. |
| `service.discover` | — | list of `{ service, moduleId }` | List all registered services and their provider modules. |
| `service.resolve` | `{ service }` | `moduleId` | Resolve which module provides a specific service. Returns error if service not found. |
| `permissions.request` | `{ permissions, reason? }` | `{ granted, pending?, denied?, requestId? }` | Request additional runtime permissions from the user. If approval is required, returns `pending: true` with a `requestId` for tracking. |
| `permissions.check` | `{ permissions }` | `{ granted, missing }` | Check which of the requested permissions are currently granted and which are missing. |

**Config scoping:** a module can only read/write its own config section (identified by `configKey` in the manifest). Path traversal patterns (`..`, `__proto__`, `constructor`, `prototype`) are rejected. Violations are rejected and logged as security events.

---

## 10. Configuration System

### Config file: `<home>/.pons/config.yaml`

```yaml
logging:
  level: info            # trace | debug | info | warn | error | fatal
  levels:
    module-agent: debug  # per-module level override

# Module-specific sections below (each module owns its key)
models:
  providers:
    - id: openai
      apiKey: ${OPENAI_API_KEY}
```

### How it works

1. Each module declares a config schema (using any schema validation library available in the implementation language)
2. On boot, the kernel discovers and imports all module schemas, merges them into an `AppSchema`
3. Loads `config.yaml`, validates against `AppSchema`, fills in defaults
4. On hot-reload signal: compares against previous config, sends `config:update` only to affected modules
5. Each module receives **only its own section** — other sections are never forwarded

### Schema file security

Before loading a schema file, the kernel performs security checks to prevent malicious schema files from executing arbitrary code:

1. **Path containment** — the schema file path must resolve to a location within the module directory (after symlink resolution). Paths escaping the module dir are rejected.
2. **Extension whitelist** — only `.ts`, `.js`, or `.json` extensions are accepted
3. **Static pattern scan** — the kernel scans the schema file source for forbidden patterns before importing it:
   - Process spawning (e.g. `exec`, `spawn`, `Command`)
   - Network access (e.g. `listen`, `connect`, `fetch`, `WebSocket`)
   - Dynamic code execution (e.g. `eval`, dynamic `import()`)
   - File system mutations (e.g. `remove`, `unlink`)
   - If any pattern is found, the schema is skipped with a warning — the module still loads but without schema validation
   - The exact pattern list is implementation-specific; each runtime adds its own dangerous APIs to the scan

This is defense-in-depth: the runtime sandbox already restricts module permissions, but schema files may be imported into the kernel process itself, so additional guards are necessary.

### Module config declaration (in manifest)

```json
{
  "configKey": "models",
  "configSchema": "./src/config.schema"
}
```

---

## 11. Security Model

### Principle: Fail-Closed, Defense-in-Depth

**Layers:**

1. **Process Sandbox** — each module runs as a separate process with the minimum required OS permissions; the runtime should enforce permission boundaries (e.g. sandboxed runtimes, seccomp, containers)
2. **Manifest Hash** — a cryptographic hash (e.g. SHA-256) of the module manifest is stored at install time and verified on every load (tamper detection)
3. **Permission Store** — permissions are stored in `<home>/.pons/permissions.yaml` and must be explicitly approved by the user at install time
4. **Runtime Enforcer** — every RPC call, pub/sub publish/subscribe, and config access is checked against declared capabilities before being forwarded
5. **Static Audit** — source scan at install time for patterns that could bypass sandbox restrictions (see below)

### Permission Types (in manifest → `permissions`)

```json
{
  "permissions": {
    "net": ["api.openai.com"],
    "read": ["~/.pons/", "./workspace/"],
    "write": ["~/.pons/data/"],
    "env": ["OPENAI_API_KEY", "HOME"],
    "run": ["git"],
    "sys": ["hostname"]
  }
}
```

These are translated into the appropriate sandbox restrictions for the target runtime (e.g. OS-level flags, container policies, seccomp profiles).

**Default when no permissions declared: deny all.**

### Capabilities (RPC and topic access)

```json
{
  "capabilities": {
    "services": ["llm", "memory"],
    "topics": ["agent.task", "agent.result"]
  }
}
```

- A module may only call services listed in its `capabilities.services`
- A module may only publish/subscribe to topics listed in its `capabilities.topics`
- Capabilities are stored in the Permission Store at install approval time — **not self-asserted by the module at runtime**
- On `ready`, the kernel loads capabilities from the store (falling back to manifest if no store entry exists for backward compatibility)
- Violation → log the event + kill the module

### Permission Store (`permissions.yaml`)

The permission store persists approved permissions and capabilities across kernel restarts.

```yaml
modules:
  module-agent:
    manifestHash: "sha256:a1b2c3..."       # SHA-256 of module.json at approval time
    firstSpawn: "2026-01-15T10:30:00Z"      # Timestamp of first install
    permissions:                             # Approved OS-level permissions
      net: ["api.openai.com"]
      read: ["~/.pons/"]
      write: ["~/.pons/data/"]
      env: ["HOME"]
    capabilities:                            # Approved IPC-level capabilities
      services: ["llm", "memory"]
      topics: ["inbound:message", "agent:turn:start"]
    dynamicPermissions: {}                   # Runtime-requested permissions (granted)
    pendingRequests: []                      # Queued permission requests (awaiting user)
    deniedRequests: []                       # Denied requests (prevents re-prompting)
```

**Manifest tamper detection flow:**
1. At `pons module install` — user reviews and approves permissions. SHA-256 hash of `module.json` is computed and stored.
2. On every kernel boot — for each module, compute current hash and compare against stored hash.
3. If mismatch → refuse to load module. Log error: `"manifest hash mismatch for module-X — re-install required"`.
4. This prevents privilege escalation via silent manifest edits.

**Runtime permission request flow:**
1. Module sends `call("permissions.request", { permissions, reason })`
2. Kernel queues the request and sends a system notification (macOS AppleScript / Linux `notify-send`) — best-effort
3. User approves or denies via CLI: `pons permissions grant <requestId>` / `pons permissions deny <requestId>`
4. On grant: permissions added to `dynamicPermissions`, module restarted with new effective permissions
5. On deny: request moved to `deniedRequests`, module receives `{ granted: false, denied: true }`

### Static Audit Scanner

At module install time (`pons module install`), the kernel scans module source files for patterns that could bypass the runtime sandbox. This is **advisory only** — it does not prevent installation but displays warnings to the user during the approval flow.

**Scanned patterns:**
- Node.js API imports: `node:fs`, `node:child_process`, `node:net`, `node:http`, `node:https`, `node:dgram`, `node:tls`
- Dynamic require: `createRequire`
- Dynamic imports: `import('node:...')`

**Limitations:**
- Cannot detect obfuscated or dynamically constructed imports
- Does not scan transitive dependencies
- Applies primarily to JavaScript/TypeScript modules — other runtimes rely on OS-level sandboxing

This scanner is defense-in-depth: it catches accidental sandbox bypasses. Intentional bypasses by a malicious module require OS-level containment (containers, seccomp, etc.).

---

## 12. Reload Signals

The kernel listens for OS signals to trigger live updates without downtime:

| Signal | Action |
|--------|--------|
| `SIGINT` / `SIGTERM` | Graceful shutdown |
| `SIGUSR1` | Config hot-reload (re-read config file) |
| `SIGUSR2` | Permission hot-reload (re-read permissions file) |
| `SIGHUP` | Module discovery + hot-load newly installed modules |

The CLI sends these signals after writing updated files.

> **Note for non-Unix implementations:** on platforms without POSIX signals, equivalent mechanisms (e.g. named pipes, admin HTTP endpoints, file watchers) should be used to trigger the same behaviors. See Section 19 (Known Limitations) for details.

---

## 13. Logging

The kernel aggregates its own logs together with logs forwarded from modules via IPC (`log` and `log-group` messages).

**Log levels:** `trace`, `debug`, `info`, `warn`, `error`, `fatal`

**Log output:**
- Development: human-readable colorized format to stdout + daily rotating file
- Production: structured JSON to stdout

**Log file path:** `<home>/.pons/.runtime/logs/kernel-YYYY-MM-DD.log`

Each log entry includes at minimum: `level`, `timestamp`, `module` (source), `msg`.

---

## 14. Error Handling

Every failure in the kernel has a defined response. This section is the single source of truth for what happens when things go wrong.

### Module failures

| Failure | Kernel response |
|---------|----------------|
| Module crashes (exit code ≠ 0) | Log error with last stderr line. Restart with exponential backoff (see Section 7). |
| Module does not send `ready` within 30s | Kill process. Treat as crash → restart logic. |
| Module fails health check (no `pong` in 10s) | Retry up to 3 times (one per health interval). After 3 consecutive failures → kill process → restart logic. |
| Module sends unknown message type | Log warning with module ID and message type. Drop message. Module is not killed. |
| Module sends malformed JSON on stdout | Log warning. Treat line as plain text (stderr-like). Module is not killed but may time out if `ready` was never sent. |
| Module writes binary data on stdout | Same as malformed JSON — logged, dropped, not fatal. |
| Module sends message after being killed | Ignore. Process stdout/stderr may still be buffered; kernel discards messages from modules not in `ready` or `starting` state. |
| Two modules declare same service | Second module is rejected at registration. Log error. Module is killed with reason `duplicate-service`. |
| Circular dependency detected | All modules in the cycle are killed with reason `circular-dependency`. Cycle path is logged. |
| Module exceeds max restart attempts (5) | Module status set to `crashed`. No further restarts. Log error. Operator must intervene (`pons module restart <id>`). |

### IPC failures

| Failure | Kernel response |
|---------|----------------|
| Write to module stdin fails | Log warning. Message is lost. No retry. Module may be dead — wait for exit event. |
| Module stdout closes unexpectedly | Treat as crash → call `onShutdown()` if possible, then restart logic. |
| Very large JSON message (>1 MB) | No built-in limit in v1. Implementations should consider adding a configurable max message size. |
| Partial JSON (buffer split mid-line) | The newline-delimited protocol guarantees complete lines. Partial reads are buffered until `\n` is received. |

### RPC failures

| Failure | Kernel response |
|---------|----------------|
| RPC target service not found | Immediate error response to caller: `{ error: "service_not_found" }` |
| RPC target module not ready | Immediate error response to caller: `{ error: "module_not_ready" }` |
| RPC timeout (30s) | Error response to caller: `{ error: "timeout" }`. Late responses from target are silently dropped. |
| RPC caller capability violation | Error response to caller: `{ error: "forbidden" }`. Log security violation. |

### Config failures

| Failure | Kernel response |
|---------|----------------|
| `config.yaml` missing at boot | Use schema defaults for all sections. Log warning. |
| `config.yaml` is invalid YAML | Reject load. Keep previous config in memory. Log error with parse details. |
| `config.yaml` fails schema validation | Log validation errors per field. Fill invalid fields with defaults. Load succeeds with warnings. |
| `config.yaml` deleted while running | No effect until next hot-reload. On hot-reload: treat as missing → use defaults. |
| Hot-reload fails mid-save | Keep previous config. Log error. No modules are notified. |
| Module requests config outside its scope | Reject call with error. Log security violation. |

### Security violations

| Violation | Kernel response |
|-----------|----------------|
| Module calls undeclared service | Reject RPC. Log violation with caller ID, target service. Kill module. |
| Module publishes to undeclared topic | Reject publish. Log violation. Kill module. |
| Module manifest hash mismatch | Refuse to load module. Log error with module ID. |

---

## 15. Limits & Defaults

All timeouts, limits, and defaults in one place. These values should be configurable where noted.

### Timeouts

| Parameter | Default | Configurable | Description |
|-----------|---------|-------------|-------------|
| RPC timeout | 30s | Yes (per-call) | Max time to wait for an RPC response |
| Health check interval | 30s | Yes (kernel config) | Time between ping messages |
| Health check response timeout | 10s | Yes (kernel config) | Max time to wait for pong reply |
| Health check max failures | 3 | Yes (kernel config) | Consecutive failures before kill |
| Module ready timeout | 30s | Yes (kernel config) | Max time to wait for `ready` after spawn |
| Dependency wait timeout | 30s | Yes (kernel config) | Max time to wait for required services |
| Graceful shutdown timeout | 5s | Yes (kernel config) | Time to wait for modules to exit voluntarily |

### Limits

| Parameter | Default | Configurable | Description |
|-----------|---------|-------------|-------------|
| Max restart attempts | 5 | Yes (kernel config) | After this, module is marked `crashed` |
| Max restart backoff | 60s | Yes (kernel config) | Upper bound on exponential backoff delay |
| IPC write queue depth | 512 | No (v1) | If a module's stdin write queue reaches this limit, the module is marked as disconnected and all further messages to it are dropped. This prevents memory exhaustion when a module cannot keep up. |
| Max IPC message size | No limit (v1) | Planned (v2) | Recommended: implementations should cap at 10 MB |
| Max concurrent modules | No limit (v1) | Planned (v2) | Limited by OS process capacity |
| Max IPC string field length | 256 chars | No (v1) | Validated on incoming messages. Fields exceeding this limit cause message rejection. |

### Defaults

| Parameter | Default | Description |
|-----------|---------|-------------|
| Logging level | `info` | Kernel-wide default |
| Config file | `<home>/.pons/config.yaml` | Main config location |
| Permissions file | `<home>/.pons/permissions.yaml` | Approved permissions location |
| Module directory | `<home>/.pons/modules/` | Where modules are installed |
| PID file | `<home>/.pons/.runtime/kernel.pid` | Kernel process ID |
| Default runtime | `deno` | When manifest omits `runtime` field |

---

## 16. Message Delivery Guarantees

The kernel provides **at-most-once** delivery for all message types. This is a deliberate design choice — the kernel is a router, not a broker.

### What is guaranteed

- Messages are delivered in the order they are sent from a single publisher to a single subscriber (FIFO per-pair)
- RPC responses are matched to their requests by ID
- A module only receives `deliver` messages for topics it has subscribed to
- A module only receives `rpc_request` messages for services it provides

### What is NOT guaranteed

- If a module's IPC write queue exceeds 512 messages, the module is marked disconnected and messages are dropped (see Section 15)
- If a module crashes between receiving a message and processing it, the message is lost
- Pub/sub has no acknowledgment — the kernel does not know if a subscriber processed the message
- RPC responses that arrive after timeout are silently discarded
- Message ordering across multiple publishers is not guaranteed

### Implications for module developers

Modules that require stronger guarantees must implement them at the application level: idempotency keys for RPC calls, acknowledgment protocols on top of pub/sub, persistent queues for critical events.

---

## 17. Protocol Versioning

### Kernel ↔ Module compatibility

The kernel and modules negotiate protocol compatibility via the manifest and the `init` message.

The `init` message includes a `protocolVersion` field:

```json
{ "type": "init", "protocolVersion": "1.0", "config": {}, "workspacePath": "...", "projectRoot": "..." }
```

The module's manifest includes a `minProtocolVersion` field (optional, defaults to `"1.0"`):

```json
{
  "id": "module-agent",
  "minProtocolVersion": "1.0"
}
```

**Version matching rules:**
- Major version must match exactly (kernel v1.x only loads modules requiring v1.x)
- Minor version: kernel must be ≥ module's minimum (kernel v1.3 can run module requiring v1.0)
- If incompatible: kernel refuses to load module, logs error with both versions

### Backward compatibility contract

- New message types may be added in minor versions — modules must ignore unknown types gracefully
- Existing message fields are never removed or renamed within a major version
- New optional fields may be added to existing messages in minor versions

---

## 18. Observability

### Kernel health

The CLI provides `pons status` which reports:
- Kernel process: running / stopped (PID, uptime)
- Per-module status: `ready`, `starting`, `crashed`, `stopped`
- Per-module last health check: timestamp, pass/fail
- Service directory: which services are registered and by whom

### Structured log events

Beyond regular log messages, the kernel emits structured events for key lifecycle moments:

| Event | Logged when | Key fields |
|-------|-------------|------------|
| `kernel.boot` | Kernel starts | version, moduleCount, configPath |
| `kernel.shutdown` | Kernel stops | reason, uptime |
| `module.spawn` | Module process started | moduleId, pid, runtime |
| `module.ready` | Module sent ready | moduleId, startupMs |
| `module.crash` | Module exited unexpectedly | moduleId, exitCode, stderr, restartCount |
| `module.killed` | Kernel killed a module | moduleId, reason |
| `rpc.timeout` | RPC call exceeded timeout | callerId, targetService, method, timeoutMs |
| `security.violation` | Capability/permission check failed | moduleId, action, target |
| `config.reload` | Config hot-reload completed | changedSections, affectedModules |

All events are written to the kernel log. In production mode (JSON output), they can be ingested by external monitoring systems (ELK, Datadog, Grafana Loki, etc.).

---

## 19. Known Limitations (v1)

This section documents what v1 explicitly does not support. These are intentional scope decisions, not bugs.

- **No high availability.** The kernel is a single process, single host. If it dies, all modules die. Use an external process supervisor (systemd, launchd) for automatic restart.
- **No clustering.** Modules cannot span multiple machines. All modules must run on the same host as the kernel.
- **No message persistence.** Pub/sub is in-memory only. Messages are lost on crash. Modules that need durability must implement their own persistence.
- **Limited backpressure.** If a module's IPC write queue exceeds 512 messages, the module is marked disconnected and messages are dropped. The kernel does not slow down publishers — it drops messages to the slow consumer.
- **No module-level resource limits.** The kernel does not enforce CPU/memory quotas per module. This is delegated to OS-level mechanisms (cgroups, containers).
- **No horizontal scaling.** A single kernel can only be as powerful as the host it runs on.
- **No built-in authentication for IPC.** Modules are trusted once approved at install time. There is no per-message signing or encryption on the stdin/stdout channel.
- **No Windows signal support.** SIGUSR1/SIGUSR2/SIGHUP are Unix-only. Windows implementations must use alternative mechanisms (see Section 12).

---

## 20. File System Layout

```
<home>/.pons/                     # or $PONS_HOME
├── modules/
│   └── {module-id}/              # Module directory
│       ├── module.json           # Manifest
│       └── src/                  # Source code
├── config.yaml                   # Global config
├── permissions.yaml              # Approved permissions
└── .runtime/
    ├── kernel.pid                # Kernel PID file
    └── logs/
        └── kernel-YYYY-MM-DD.log
```

---

## 21. Multi-Runtime Module Support

Modules can be written in any programming language. The kernel does not assume a specific runtime — it reads the `runtime` field from the module manifest and spawns the appropriate process.

### Supported runtimes

| runtime | Spawn command | Sandbox mechanism |
|---------|--------------|-------------------|
| `deno` | `deno run [permission-flags] <entry>` | Deno permission flags (--allow-net, --allow-read, etc.) |
| `node` | `node <entry>` | Process-level restrictions (future: policy file) |
| `bun` | `bun run <entry>` | Process-level restrictions |
| `go` | `./<entry>` (pre-compiled binary) | OS-level (seccomp, containers) |
| `rust` | `./<entry>` (pre-compiled binary) | OS-level (seccomp, containers) |
| `python` | `python <entry>` | OS-level (seccomp, containers) |
| `php` | `php <entry>` | OS-level (seccomp, containers) |
| `binary` | `./<entry>` (any executable) | OS-level (seccomp, containers) |

If `runtime` is omitted, the kernel defaults to `deno` for backward compatibility.

### How it works

1. Kernel reads `runtime` and `entry` from `module.json`
2. Constructs the spawn command based on the runtime table above
3. For `deno` runtime: translates `permissions` to Deno CLI flags
4. For all other runtimes: spawns the process directly; sandbox enforcement is delegated to OS-level mechanisms
5. Regardless of runtime, IPC is identical: newline-delimited JSON over stdin/stdout

### SDK per language

Each supported language needs a thin SDK (~200–400 lines) that implements the IPC protocol. See the **SDK Specification** (`docs/specs/sdk.md`) for the full contract.

### Config schema for non-TypeScript modules

Modules written in languages other than TypeScript cannot export a Zod schema. Instead, they declare their config schema as a JSON Schema file:

```json
{
  "configKey": "my-module",
  "configSchema": "./config.schema.json"
}
```

The kernel accepts both formats: if the schema file extension is `.json`, it is loaded as JSON Schema. If `.ts` or `.js`, it is imported as a Zod schema. Both are used for validation equally.

---

## 22. Module Manifest (module.json)

```json
{
  "id": "module-agent",
  "name": "Agent Module",
  "version": "1.0.0",
  "runtime": "deno",
  "entry": "src/runner.ts",
  "priority": 10,
  "provides": ["agent"],
  "requires": ["llm", "memory"],
  "optionalRequires": ["sandbox"],
  "configKey": "agents",
  "configSchema": "./src/config.schema.ts",
  "permissions": {
    "net": [],
    "read": ["~/.pons/"],
    "write": ["~/.pons/data/"],
    "env": ["HOME"],
    "run": [],
    "sys": []
  },
  "capabilities": {
    "services": ["llm", "memory"],
    "topics": ["agent.task", "agent.result", "agent.status"]
  }
}
```

**Fields:**
- `id` — unique identifier (slug, lowercase, hyphens)
- `name` — human-readable name
- `version` — semver string
- `runtime` — execution runtime (see Section 21). Defaults to `deno` if omitted.
- `entry` — path to the entry point, relative to the module directory
- `priority` — spawn order (lower = earlier)
- `provides` / `requires` / `optionalRequires` — service graph declarations
- `configKey` — top-level key in `config.yaml` that this module owns
- `configSchema` — path to the config schema definition (`.ts`/`.js` for Zod, `.json` for JSON Schema)
- `permissions` — OS-level access requests (approved at install time)
- `capabilities` — IPC-level access declarations (enforced at runtime)

---

## 23. What the Kernel Does NOT Do

- Does not store or queue messages (no persistence, no replay)
- Does not contain any business logic
- Does not integrate with LLMs
- Does not manage user workspace or files
- Does not expose an HTTP API (that is the responsibility of a gateway module)
- Does not implement skills or agents — those live in modules

---

## 24. CLI — Service Registration

The CLI includes a `service` subcommand for registering the kernel as a system service with automatic restart on failure and autostart on boot.

**Commands:** `pons service install`, `uninstall`, `start`, `stop`, `status`, `logs`

**Requirements:**
- Auto-detect host platform: systemd (Linux), launchd (macOS), Task Scheduler (Windows)
- User-level install by default (no root required); system-level install optional with privilege elevation
- Service must restart kernel on failure (restart delay: 5s)
- `uninstall` reverses all registration steps without removing Pons data or config
- Platform-specific service file formats and commands are implementation details of the CLI, not the kernel

---

## 25. Extension Points

**Adding a new kernel call:**
1. Add a handler in the kernel's call dispatcher
2. Add capability/permission checks in the enforcer if the call accesses sensitive resources
3. Document it in Section 9 of this specification

**Adding error handling for a new failure mode:**
1. Determine the failure category (module, IPC, RPC, config, security)
2. Add a row to the appropriate table in Section 14
3. Implement the response in the relevant component

**Changing the IPC protocol:**
1. Update the shared type definitions (SDK / shared types package)
2. Update message handlers in the lifecycle manager
3. Bump the kernel version and document the change

**Adding a new runtime:**
1. Add a row to the runtime table in Section 21
2. Add the spawn command logic in the lifecycle manager's `forkProcess()` function
3. Implement or point to an SDK for that language
4. Document sandbox mechanism (if any)

**Porting the kernel itself to another language:**
The kernel can be implemented in any language capable of spawning child processes and communicating over stdin/stdout. The IPC protocol (newline-delimited JSON), manifest format (JSON), and config format (YAML) are the only cross-language contracts that must be preserved exactly. Everything else — class names, file structure, libraries — is an implementation detail.

---

## Appendix A. IPC Session Examples

These examples show the exact JSON messages exchanged between the kernel and modules during real scenarios. Use them as a reference when implementing the protocol.

### A.1. Module startup — happy path

```
KERNEL → module-llm:   {"type":"init","protocolVersion":"1.0","config":{"models":{"providers":[{"id":"anthropic","type":"anthropic"}]}},"workspacePath":"/home/user/.pons/workspace","projectRoot":"/home/user/project"}
module-llm → KERNEL:   {"type":"ready","manifest":{"id":"module-llm","name":"LLM Module","version":"1.0.0","provides":["llm"],"requires":[],"configKey":"models"},"capabilities":{"services":[],"topics":["llm:usage"]}}
KERNEL → module-llm:   {"type":"deps_ready"}
```

### A.2. Module startup — waiting for dependencies

```
KERNEL → module-agent:  {"type":"init","protocolVersion":"1.0","config":{"agents":{"defaultModel":"claude-sonnet-4"}},"workspacePath":"/home/user/.pons/workspace","projectRoot":"/home/user/project"}
module-agent → KERNEL:  {"type":"ready","manifest":{"id":"module-agent","provides":["agent"],"requires":["llm","memory"]},"capabilities":{"services":["llm","memory"],"topics":["inbound:message","agent:turn:start","agent:turn:end"]}}

  (kernel holds module-agent in "waiting" — llm and memory not yet available)
  (module-llm and module-memory start and register their services)

KERNEL → module-agent:  {"type":"deps_ready"}
```

### A.3. Health check

```
KERNEL → module-llm:   {"type":"ping"}
module-llm → KERNEL:   {"type":"pong"}
```

### A.4. Pub/sub — agent publishes turn start, gateway receives it

```
module-agent → KERNEL:  {"type":"publish","topic":"agent:turn:start","payload":{"agentId":"support-agent","sessionId":"sess-001","runId":"run-abc"}}

  (kernel looks up subscribers of "agent:turn:start" — finds module-gateway)

KERNEL → module-gateway: {"type":"deliver","id":"msg-7f3a","topic":"agent:turn:start","payload":{"agentId":"support-agent","sessionId":"sess-001","runId":"run-abc"}}
```

### A.5. RPC — agent calls LLM to generate text

```
module-agent → KERNEL:  {"type":"rpc_request","id":"rpc-001","service":"llm","method":"generateText","params":{"provider":"anthropic","model":"claude-sonnet-4","system":"You are a helpful assistant.","messages":[{"role":"user","content":"Hello"}]}}

  (kernel checks agent's capabilities — "llm" is declared — forwards to module-llm)

KERNEL → module-llm:   {"type":"rpc_request","id":"rpc-001","from":"module-agent","service":"llm","method":"generateText","params":{"provider":"anthropic","model":"claude-sonnet-4","system":"You are a helpful assistant.","messages":[{"role":"user","content":"Hello"}]}}

  (module-llm processes the request, calls the LLM API)

module-llm → KERNEL:   {"type":"rpc_response","id":"rpc-001","result":{"content":"Hello! How can I help you today?","usage":{"promptTokens":15,"completionTokens":9,"totalTokens":24}}}

  (kernel forwards response back to caller)

KERNEL → module-agent: {"type":"rpc_response","id":"rpc-001","result":{"content":"Hello! How can I help you today?","usage":{"promptTokens":15,"completionTokens":9,"totalTokens":24}}}
```

### A.6. RPC — capability violation

```
module-sandbox → KERNEL: {"type":"rpc_request","id":"rpc-002","service":"memory","method":"store","params":{"content":"secret data"}}

  (kernel checks sandbox's capabilities — "memory" is NOT declared)

KERNEL → module-sandbox: {"type":"rpc_response","id":"rpc-002","error":"forbidden"}

  (kernel logs security violation, kills module-sandbox)
```

### A.7. Kernel call — module reads its own config

```
module-agent → KERNEL:  {"type":"call","id":"call-001","method":"config.get","params":{"key":"agents.defaultModel"}}
KERNEL → module-agent:  {"type":"call:response","id":"call-001","result":"claude-sonnet-4"}
```

### A.8. Config hot-reload

```
  (operator runs: pons config set models.providers[0].model claude-opus-4 → CLI writes config.yaml, sends SIGUSR1)

KERNEL → module-llm:   {"type":"config:update","config":{"models":{"providers":[{"id":"anthropic","type":"anthropic","model":"claude-opus-4"}]}},"changedSections":["models"]}
```

### A.9. Graceful shutdown (ordered drain)

```
  (operator runs: pons kernel stop → sends SIGTERM)
  (kernel computes shutdown order from dependency graph)

  ── Tier 1: module-gateway (leaf — no one depends on it) ──

KERNEL → subscribers of system:module:stopping: {"type":"deliver","id":"sys-001","topic":"system:module:stopping","payload":{"moduleId":"module-gateway","tier":1}}
KERNEL → module-gateway: {"type":"shutdown"}
  (module-gateway stops accepting connections, cleans up, exits within 5s)

  ── Tier 2: module-agent, module-sandbox ──

KERNEL → subscribers of system:module:stopping: {"type":"deliver","id":"sys-002","topic":"system:module:stopping","payload":{"moduleId":"module-agent","tier":2}}
KERNEL → module-agent:   {"type":"shutdown"}
KERNEL → module-sandbox: {"type":"shutdown"}
  (both finish in-flight work, exit within 5s)

  ── Tier 3: module-llm, module-memory (roots) ──

KERNEL → module-llm:    {"type":"shutdown"}
KERNEL → module-memory:  {"type":"shutdown"}
  (both exit)
  (kernel removes PID file, closes logs, exits)
```

### A.10. Full scenario — user sends message to agent

This shows the complete message flow when a user sends "Hello" via the gateway to an agent:

```
  ── Step 1: Gateway receives HTTP/WS request, publishes to bus ──

module-gateway → KERNEL: {"type":"publish","topic":"inbound:message","payload":{"agentId":"support-agent","senderId":"user-42","channelType":"chat","channelId":"ws-conn-7","content":"Hello"}}

  ── Step 2: Kernel delivers to module-agent (subscribed to inbound:message) ──

KERNEL → module-agent:  {"type":"deliver","id":"msg-a1b2","topic":"inbound:message","payload":{"agentId":"support-agent","senderId":"user-42","channelType":"chat","channelId":"ws-conn-7","content":"Hello"}}

  ── Step 3: Agent assembles context and calls LLM via RPC ──

module-agent → KERNEL:  {"type":"rpc_request","id":"rpc-010","service":"llm","method":"generateText","params":{"provider":"anthropic","model":"claude-sonnet-4","system":"You are a support agent...","messages":[{"role":"user","content":"Hello"}],"tools":[{"name":"remember","description":"Save to memory","parameters":{}}]}}
KERNEL → module-llm:    {"type":"rpc_request","id":"rpc-010","from":"module-agent","service":"llm","method":"generateText","params":{"provider":"anthropic","model":"claude-sonnet-4","system":"You are a support agent...","messages":[{"role":"user","content":"Hello"}],"tools":[{"name":"remember","description":"Save to memory","parameters":{}}]}}

  ── Step 4: LLM responds ──

module-llm → KERNEL:    {"type":"rpc_response","id":"rpc-010","result":{"content":"Hi there! How can I help you today?","usage":{"promptTokens":42,"completionTokens":11,"totalTokens":53}}}
KERNEL → module-agent:  {"type":"rpc_response","id":"rpc-010","result":{"content":"Hi there! How can I help you today?","usage":{"promptTokens":42,"completionTokens":11,"totalTokens":53}}}

  ── Step 5: Agent publishes response to gateway via bus ──

module-agent → KERNEL:  {"type":"publish","topic":"outbound:ws","payload":{"type":"stream:final","agentId":"support-agent","sessionId":"sess-001","channelId":"ws-conn-7","content":"Hi there! How can I help you today?"}}
KERNEL → module-gateway: {"type":"deliver","id":"msg-c3d4","topic":"outbound:ws","payload":{"type":"stream:final","agentId":"support-agent","sessionId":"sess-001","channelId":"ws-conn-7","content":"Hi there! How can I help you today?"}}

  ── Step 6: Agent persists transcript via RPC ──

module-agent → KERNEL:  {"type":"rpc_request","id":"rpc-011","service":"transcripts","method":"append","params":{"sessionId":"sess-001","messages":[{"role":"user","content":"Hello"},{"role":"assistant","content":"Hi there! How can I help you today?"}]}}
KERNEL → module-memory:  {"type":"rpc_request","id":"rpc-011","from":"module-agent","service":"transcripts","method":"append","params":{"sessionId":"sess-001","messages":[{"role":"user","content":"Hello"},{"role":"assistant","content":"Hi there! How can I help you today?"}]}}
module-memory → KERNEL:  {"type":"rpc_response","id":"rpc-011","result":{"ok":true}}
KERNEL → module-agent:   {"type":"rpc_response","id":"rpc-011","result":{"ok":true}}

  ── Step 7: Agent emits turn:end ──

module-agent → KERNEL:  {"type":"publish","topic":"agent:turn:end","payload":{"agentId":"support-agent","sessionId":"sess-001","runId":"run-abc","usage":{"promptTokens":42,"completionTokens":11,"totalTokens":53},"durationMs":1250}}
```
