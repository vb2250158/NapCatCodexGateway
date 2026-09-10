English | [简体中文](source-hot-patches.md)

# Source hot patches

Installed pages and independent Web Bundles use [Web hot patches](web-hot-patches_en.md), validated and published separately from backend source patches.

## Upgrade and legacy checks

- Before a full release, run the candidate's `scripts/check-source-patch-upgrade.mjs <absolute candidate root> <absolute source-patch state root>`. Developer activation performs this read-only check before stopping Host. Active overrides, contract overrides and unresolved operations block the upgrade while preserving the current service. Use formal rollback/reconciliation in the original version to restore a confirmed baseline before retrying.
- If active code already equals the old packaged baseline, contracts match and no operation is unresolved, startup first validates the new module, archives the entire old pointer by content hash under `baseline-history/<moduleId>/`, then atomically updates the active baseline. Original receipts and candidates remain intact. Failed startup or archival does not clear the old pointer.
- `/api/source-patches` exposes module loading errors. Failed modules make `/meta` and `/health` degraded without stopping unrelated APIs. Upgrade acceptance must include historical state, another restart, package-baseline rollback, archival failures and unresolved receipts, not only an empty data directory.

- Installing this capability for the first time, or changing the hot-patch runtime itself, still requires a Host-managed version switch. Subsequent compatible source and resource edits in the catalog publish automatically without a restart for every edit.
- Developer Channel fully replaces packaged documentation, plugins, Skills, and source patch catalogs; removed files must not reappear from the old package. Build and acceptance must use the same frozen source, not another task's changing `dist/`.
- After installation, rediscover the Host address, match the generation/instance in `/meta`, and verify `/api/source-patches`, watcher state, and the actual asset hashes referenced by the WebGUI root HTML.
- Dynamic registrations, active pointers, and uncertain operation receipts are recovery evidence, not obsolete files to delete. They prevent repeated initialization and uncertain operation replay. Retire an old baseline only after reconciling its original operations and applying an explicit migration; deleting records, changing IDs, or resetting business data is not a migration.

The repository-local [source hot-patch development Skill](../skills/source-hot-patch-development/SKILL.md) provides the Agent workflow. Read it on demand; its presence does not mean it is installed in every Agent.

Status: partial runtime acceptance passed; full coverage remains in development. On 2026-09-10, the installed application automatically applied and restored the plugin catalog module (revision 0→1→2) without changing the Manager identity or module Worker. This acceptance covers that integrated module, not all source files, resources, or complex closures. Existing plugin reconciliation and source patches remain separate interfaces.

Watching uses a bounded compiler Worker. Catalog edits update resource and relative TypeScript dependency watches; invalid edits retain the last valid configuration. Saves during compilation discard stale candidates. Existing modules sharing dependencies or resources publish through the managed two-phase transaction; independent groups continue when another group fails compilation. New modules compile and register automatically without changing the hot-patch core, adding business-specific branches, or restarting Manager.

## Current implementation

### Add a module without changing the core

Create the source and resources under the source root and append a declaration to the `modules` array in `source-patches/modules.json`:

```json
{
  "id": "example.counter",
  "source": "src/extensions/counter.ts",
  "resources": ["assets/counter-label.txt"],
  "dependencies": { "state": { "count": 0 }, "settings": { "step": 1 } },
  "contract": { "description": "有状态计数 / Stateful counter" }
}
```

The source declares named dependencies with `declare const state` and `declare const settings` and exports callable functions. `dependencies` contains up to 64 KiB of JSON initial values, structurally cloned into the module Worker, not shared mutable references or arbitrary injected functions. Compatible code updates preserve module variables, class instances, and dependency objects. Changing initial values is not migration: the watcher rejects replacement of registered dependencies rather than resetting state. The module owner supplies forward and reverse migrations through the explicit protocol below; automatic watching does not perform declaration-shape migrations.

Integration plugins use the common `host.manager.source-patches@1` service: `invoke(moduleId, exportedSymbol, arguments)` returns the actual request revision and contract, and `status()` returns observational state. Business HTTP routes, permissions, and input validation remain plugin-owned; arbitrary exported functions are not automatically exposed over HTTP. No module-name registration is needed in the hot-patch core.

First registration writes `data/.runtime/source-patches/registrations/<moduleId>.json`: `preparing` is saved before initialization, and calls open only after initialization succeeds and `active` is persisted. Registration shares the plugin generation publication fence. After interruption, only `active` registrations recover; `preparing` or damaged records fail closed without replaying initialization. Initializers must not write business data; Worker isolation is not a malicious-code sandbox. Failed registration records are not automatically deleted or bypassed using new module IDs.

Normal restart restores the registered baseline, confirmed patches, and declared dependencies, not a heap snapshot. Removing an entry stops automatic watching but does not terminate serving calls or delete durable records. Re-adding the same ID retains its instance and baseline. Moving a dynamic module into an installed package requires explicit rebase on baseline conflict. Multiple newly declared modules have independent registration outcomes; first initialization is not a cross-module business transaction.

Unless `RABIROUTE_HOT_PATCH_WATCH` is `0`, Manager watches `source-patches/modules.json` under its source root and the declared source, dependencies, and resources. The catalog may first be created after startup; missing modules are registered in the background. Installed builds may set `RABIROUTE_HOT_PATCH_SOURCE_ROOT` to an existing external source root. Changes debounce for 200 ms and compile into immutable candidates carrying resource bytes and SHA-256 hashes. Request leases select matching code and resources. Compilation, compatibility, or publication failures retain the old version; uncertain operations are fenced without replay. Without an external source root, installed builds watch only their own catalog path, not unrelated user directories.

`scripts/lib/hot-patch-compiler.mjs` parses TypeScript modules, resolves symbols to preserve local shadowing, and rewrites module binding references into environment access. Initialization runs once; subsequent implementations of named functions use stable dispatch. Supported constructs include named top-level functions, recursion, internal calls, async functions, ordinary module variables, instance and static methods of ordinary classes, and host-provided dependencies expressed with `declare`. Method patches preserve class identity, existing instance fields, and bound callbacks. Constructor and field-initializer changes still reject.

`src/plugin-kernel/hotPatchModule.ts` installs compiled output and applies function batches after compatibility checks. When host state must change, its `applyWithStateMigration` and `rollbackWithStateMigration` APIs provide the module-level entry for draft migration, drain checks, and revision switching. Changes to initialization, dependencies, exports, or signatures require an explicit migration and are rejected. Retained callbacks use the current implementation; an already-started async invocation and its related calls keep their original revision. Ordinary returned closures work, but replacing an existing closure body in place is not implemented.

`src/plugin-kernel/hotPatchRuntime.ts` owns monotonic revisions, function tables, immutable JSON contracts, and request leases. Failed batches do not partially publish. Rollback publishes a new revision referencing the retained previous implementation and contract; committed business data is not undone. When live state must change, callers use `applyWithStateMigration` with an explicit migration function; migration runs before publication, and any migration or patch failure restores the caller-owned state while keeping the old revision active. The retention limit rejects further patches until accepted work releases its leases. Tests of the retention table do not establish real heap-memory acceptance.

Existing Manager plugin routes now carry the activation identity of their effect commit. Dispatch only includes registrations still active in the published generation. Preparing or failed candidates cannot replace old routes prematurely. This fixes plugin route visibility, but does not yet publish source function tables, dependencies, and documentation in one transaction.

`HotPatchCandidateStore` accepts only SHA-256 identities in a designated local directory. It bounds regular-file reads and validates file identity, content hashes, and artifact structure before returning an immutable snapshot without executing code. It does not grant publishing authority or expose remote uploads. Compilation resolves type imports relative to the actual source path and checks TypeScript semantic errors in the target module. Errors include file, line, column, and diagnostic code; no candidate is emitted. Compatibility digests include declarations, import text, and resolved transitive type dependency contents. Dependency changes conservatively require migration. The compiler currently uses independent ES2022/Bundler options, not the project's complete strict checks, and does not execute dependencies. A full build remains required. Dynamic `import()` currently rejects explicitly.

Named functions and ordinary class methods support synchronous and asynchronous generators. Iterator creation pins a revision; later `next`, `throw`, `return`, and internal calls execute in that revision, including queued asynchronous resumptions. Leases release only on completion or an uncaught error; a `finally` block that yields retains its lease. Callers must exhaust iterators or call `return` and finish cleanup. Abandoning an iterator does not prove drainage. Generators may be consumed inside an execution unit, but returning an iterator directly over IPC closes it and rejects explicitly. Cross-process streaming iteration is not implemented.

## Trust and lifecycle

`src/plugin-kernel/hotPatchProcess.ts` provides an isolated child-process execution unit with bounded request and mutation queues. Applying or rolling back a patch preserves the PID and module state. A synchronous infinite loop blocks only its execution unit; a timeout terminates that unit without replaying accepted calls. Default shutdown closes admission and drains accepted calls and queued mutations. Forced shutdown cannot establish business outcomes; callers must retain uncertain results. This is not a security sandbox. The read-only plugin catalog presentation route is connected; business writes are not.

Compiled output is executable local code, not sandboxed data. `node:vm` creates implementation functions without providing a security boundary. Only trusted developers may create candidates for the managed publishing flow. Never pass untrusted HTTP bodies into compilation or installation. The publishing API accepts neither source code nor paths: only hashes already placed in the managed directory, with local Host authority.

`run` tracks its returned Promise. HTTP integration must acquire explicit leases covering both responses and actual business completion; connection closure alone is insufficient. Detached background work requires separate lifetime management. This runtime does not automatically prove that arbitrary timers and event listeners have drained.

## Manager integration and publishing contract

Execution-unit startup and accepted calls use independent budgets: `startupTimeoutMs` and `timeoutMs` both default to 15 seconds. Reducing the call deadline does not also reduce the startup budget. Initialization timeout still terminates only its own unit. The startup deadline covers process creation, module loading, and initialization; an infinite initializer is not exempt.

Documentation-only publication keeps the current `candidateSha256` and supplies a new `contract`. It creates a new revision, preserves the old contract for existing requests, and supports rollback without reconstructing instances or resetting module variables. Unchanged code and contract reject as a no-op; changing JSON object property order is not a contract change. Validation checks serializable contract structure, not semantic agreement between documentation and business behavior. Publishers must still provide matching behavior tests.

- `source-patches/modules.json` declares source modules and bilingual interface contracts. Full builds produce `dist/source-patches/catalog.json` and content-addressed baselines. The runtime does not need the TypeScript compiler.
- The real `/api/plugins/catalog` presentation logic lives in `src/manager/pluginCatalogPresentation.ts` and runs in an isolated execution unit. The `x-rabiroute-source-revision` response header comes from the actual request lease, not the newest revision at response completion. Changing source does not reopen the listener.
- `GET /api/source-patches` returns cached execution-unit status and the most recently confirmed revision and contract without waiting for business execution. Modules initialize and become ready independently: one failed or stuck initializer does not block healthy module admission. It is an observation snapshot, not proof of cross-process atomic publication of every module's documentation and function table.
- `POST /_rabiroute/host/source-patches` requires loopback, the current Host token, and `operationId`, `action=apply|rollback`, `moduleId`, `expectedRevision`, `applicationGenerationId`, `managerInstanceId`, and `pluginGenerationId`. Apply also supplies `candidateSha256` and its `contract`. Publication and plugin reconciliation share the generation mutation fence; stale identities reject.
- `GET /api/source-patches/operations/{operationId}` reads the original operation. Reusing its ID with identical contents returns the saved outcome without execution; changed contents reject. `pending` and `indeterminate` are not success. An uncertain module blocks further publication. Public receipts omit internal recovery proofs and payload fingerprints.
- `POST /_rabiroute/host/source-patches/reconcile` takes the original `operationId`, `moduleId`, and three freshly discovered runtime identities without executing the patch again. A matching durable active pointer can establish commitment. Otherwise, exact revision, source hash, and contract evidence is accepted only from the same application, Manager, PID, and random execution identity. A restarted process without durable commitment proof remains unknown; its initial revision does not prove the old operation never ran.
- Candidates live under the runtime state root at `data/.runtime/source-patches/candidates`. Sibling directories hold operation records and active source pointers. Cold startup can restore confirmed code. When the package baseline changes, only a baseline without active overrides that passes the upgrade checks above is automatically archived and migrated; other cases require explicit rebase rather than silently applying an old candidate. This restores code, not arbitrary heap objects or business data.

Publication persists the module admission latch before the operation journal and executes only after both succeed. Preparation failure returns `not_started` when its failure receipt can be saved. If the latch persists but neither the journal nor failure receipt can be saved, restarting still blocks further publication for that module. The missing operation returns 404; recovery neither removes the latch automatically nor invents a successful receipt. Reconciliation waits for the same module's startup recovery reader, without making health or unrelated modules wait for reconciliation.

Host source now accepts `--command source-patch` and `--command source-patch-reconcile`, together with `--application-generation-id <freshly discovered generation>` and `--source-patch-request <absolute JSON file path>`. The file contains the publication or reconciliation fields described above and is limited to 16 KiB. Host forwards the unchanged payload using its private authority to the published Manager without starting another Host or restarting the application. At most four forwards run concurrently without blocking the main Host command loop. Timeouts, oversized responses, and identity mismatches remain unconfirmed without replay. CLI `ok` means a valid response arrived, not that the operation committed; inspect its `state` and `commitState`. Never extract or copy the real Host token. Isolated transport tests pass; installed-runtime acceptance remains outstanding.

## Remaining acceptance scope

- Private fields, inheritance, accessors, existing closure transformations, and a cross-process iteration protocol; unsupported module declarations currently reject explicitly.
- Automatic dependency loading, declaration migration, in-place replacement of complex closures, and equivalence to ordinary full builds.
- Atomic integration with plugin generations, formal routes, and documentation snapshots.
- Installed Host CLI acceptance, cross-package rebasing, and broader process and power-loss recovery. File synchronization and injected failures do not establish arbitrary power-loss safety.
- Continuous real HTTP traffic, write idempotency, exclusive consumer handoff, long-lived connections, and heap reclamation.
- Full builds, managed runtime acceptance, and isolation of unrelated interface failures.

## Local tests

Run `npm run hot-patch:compile -- --source module.ts --output-directory data/.runtime/source-patches/candidates` to create a candidate. Add `--baseline <previous-candidate-file>` to check compatibility and skip unchanged implementations. Output filenames use their content SHA-256 and never overwrite previous candidates. This compiles only; it does not activate a patch.

```powershell
npm run test:hot-patches
```

The HTTP fixture uses an operating-system-assigned loopback port to verify old requests completing across a patch, new requests using new code, unchanged listening identity, and counters surviving rollback. It is not formal Manager runtime acceptance. These tests do not start Manager, modify business plans, send messages, or install patches into the live service.

`scripts/hot-patch-manager-api.test.mjs` exercises the real catalog and publication handlers, covering authority, original-operation deduplication, code recovery, rollback, and failed-module isolation. After a full build, setting `RABIROUTE_HOT_PATCH_TEST_BUILT=1` for that test process switches to the Manager services in `dist/` and native JavaScript child processes. `scripts/hot-patch-process.test.mjs` also supports this option to verify compiled generator boundaries and execution units. These remain isolated tests, not installed whole-application acceptance.

After a full build, also run `npm run test:hot-patches:manager`. Following the project's isolated integration-test pattern, it starts the built `startManager` control plane with core/diagnostics plugins and temporary state, reads structured READY, and verifies source replacement on the real catalog route, documentation-only publication, rollback, original-operation lookup, and concurrent health reads. Application identity, Manager PID, and source execution-unit PID remain unchanged. The fixture shuts down its own control plane through its test Host authority without operating the installed Host. It does not traverse the product single-instance startup entry and does not establish installation, cold-start, or complete Host CLI acceptance.

### State migration in isolated Workers

`HotPatchProcess` can bind state to a named dependency supplied during initialization and run explicit synchronous migrations with `applyWithStateMigration` / `rollbackWithStateMigration` inside the Worker. The migration source is intended for managed candidate callers only; all retained revision leases must drain first. A failed migration keeps the old code and state, while a successful one returns a new `snapshot` and state proof. The Worker PID, connections, and bounded mutation queue remain unchanged.

State dependencies enter the Worker through structured cloning, and callers can request a read-only proof with `snapshot(stateDependency)`. Arbitrary business objects or functions are not transferred across IPC. If migration times out, the Worker is treated as failed and accepted calls are not replayed.

### Atomic publication across modules

`HotPatchBundle` coordinates multiple `HotPatchModule` instances under one managed operation: it compiles and validates every baseline, symbol set, and contract before publishing in a fixed order. A preparation failure leaves all running modules unchanged; an exception during publication rolls back modules already published. This coordinator applies to modules in the same process. Independent Workers still require a corresponding managed boundary in the upper publication service.

### Two-phase publication for independent Workers

`HotPatchProcessBundle` provides a `prepare`, `commit`, and `discard` protocol for independent Workers. Every Worker locks its candidate, baseline, and contract before code is committed. If a commit fails, already committed Workers are rolled back and remaining preparation tokens are discarded. Preparation tokens are valid only in the current Worker process; after a Worker restart or communication timeout, publication is not replayed automatically and must follow the durable operation receipt.

Only one preparation token may exist in a Worker at a time; duplicate preparation is rejected so concurrent candidates cannot overwrite one another. A token expires after commit, discard, or Worker shutdown.

A cross-module entry point must also wrap the complete asynchronous operation in one `HotPatchBundle.run(...)` call. It acquires every module lease once and releases them only after the returned value or iterator completes. Using the bundle only for publication while calling module exports independently does not pin a request to one version.

### Formal multi-module publication

`POST /_rabiroute/host/source-patches` also accepts `action=apply-bundle`. The request carries one `operationId`, the three current runtime identities, and at least two `entries`; each entry provides `moduleId`, `candidateSha256`, `expectedRevision`, and an optional `contract`. The Manager prepares every Worker before committing the bundle. A commit or pointer-persistence failure leaves the unified operation `indeterminate` and fences admission for the affected modules. Cold start restores that fence asynchronously without delaying healthy module readiness. Query the same operation ID through `GET /api/source-patches/operations/{operationId}`; never replay with a new ID.

### Versioned resource snapshots

When the watcher detects a resource file change, it captures the resource into the immutable candidate with a `SHA-256` digest. `src/plugin-kernel/hotPatchResourceStore.ts` validates the snapshot, while the code revision and request lease select the matching resource version. A module declares its resource paths in `modules.json` and declares `__rabiResources` in source; the runtime provides `read(path)` and `text(path)` only inside an active request lease. Resource shape changes still require an explicit migration.
