<!-- docs-language-switch -->
<div align="center">
English | <a href="./plugin-bundles.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Plugin Packages, Execution Boundaries, and Hot Replacement

RabiRoute keeps application lifecycle, business state, and the Plugin Kernel in one trunk while features extend as a plugin tree. A plugin is not another Host: it provides capabilities only inside Manager-owned generations, permissions, dependencies, and process leases. Ordinary plugins never control the Windows Host/Manager/tray lifetime.

## One production format

Manifest and Profile accept schema v2 only. No other version has a compatibility parser; unknown or retired fields fail directly so one package cannot acquire two lifecycle meanings on different machines.

Production layout:

```text
plugins/
  profiles/desktop.json
  builtin/<package-id>/<version>/rabi.plugin.json
  builtin/<package-id>/<version>/manager.mjs
  builtin/<package-id>/<version>/web/
```

Out-of-tree plugins use the same package layout, schemas, SDK, and Profile instance contract. Built-in identity grants no extra lifecycle authority.

## Manifest v2

```json
{
  "schemaVersion": 2,
  "id": "io.example.feature",
  "version": "1.0.0",
  "entries": {
    "manager": {
      "execution": "isolated",
      "module": "./manager.mjs"
    },
    "desktop": {
      "execution": "declarative",
      "resource": "./desktop.json"
    }
  },
  "provides": ["example.feature@1"],
  "requires": ["manager.core@1"],
  "optional": [],
  "permissions": ["example.read"]
}
```

`provides`, `requires`, `optional`, and `readyRequires` use `name@major`. Package paths must stay inside their package. Unknown fields, duplicate capabilities, invalid permissions, and capability conflicts fail before execution.

## Three execution modes

| Mode | Use | Isolation and limits |
| --- | --- | --- |
| `in_process` | Reviewed core plugins shipped with Manager that need direct service objects | Runs inside Manager; must use SDK lifecycle/effects and cannot create another application owner |
| `isolated` | Out-of-tree code, larger failure surfaces, or plugins needing a separate process | The loader never imports entry top-level code; a dedicated Plugin Runtime Host uses restricted RPC and structured-clone data; process leases reclaim the child |
| `declarative` | Desktop/Web menus, panels, themes, and resources that need declarations only | Executes no plugin JavaScript; the kernel validates a resource and passes it to the presentation adapter |

Execution mode belongs to an entry, not the whole package. One package may declare different modes for different hosts. A manifest cannot supply arbitrary commands, executable paths, or resources outside its package.

## Profile v2

The Profile is the single source of truth for enabled deployment instances:

```json
{
  "schemaVersion": 2,
  "readyRequires": ["manager.core@1"],
  "instances": [
    {
      "id": "manager:example",
      "package": "io.example.feature",
      "version": "1.0.0",
      "enabled": true,
      "config": {},
      "grants": ["example.read"],
      "policy": {
        "restart": {
          "mode": "on_failure",
          "maxAttempts": 3,
          "windowMs": 60000,
          "initialBackoffMs": 500,
          "maximumBackoffMs": 10000
        },
        "resources": {
          "memoryMb": 256,
          "maxChildProcesses": 2,
          "shutdownTimeoutMs": 5000
        }
      }
    }
  ]
}
```

`grants` may grant only permissions declared by the Manifest and allowed by deployment. `policy` bounds instance restart and resources; the kernel supplies one default policy instead of allowing plugins to interpret missing values. A Manager generation reports ready to Host only when every `readyRequires` capability has an active provider.

## Identity and lifecycle

Every activation carries the full identity:

```text
applicationGenerationId
managerInstanceId
activationId
instanceId
pluginId
version
revision
host
```

External requests, process leases, logs, and contributions must trace back to this identity instead of relying on a reusable plugin name or PID.

Plugins register services, contributions, and effects through `activate(context)`. `context.lifecycle.signal` is the cancellation source of truth, and effects start only after the candidate generation commits. Replacement or shutdown stops admission and aborts the signal, then disposes in reverse dependency order: consumers before providers, with each instance's effects/disposers closed under kernel control.

## Process Lease

A plugin that needs a long-lived child process must create it through the shared Process Lease Registry. Lease ownership includes application generation, Manager instance, activation, plugin instance, and revision. The Registry provides:

- duplicate rejection for the same owner/key;
- the `maxChildProcesses` resource limit;
- rejection of new children after quiesce;
- drain within `shutdownTimeoutMs`, followed by process-tree termination;
- reclamation when the generation, instance, or Manager ends.

Directly spawning and losing ownership is a design contradiction. The Windows Job is a final application-generation cleanup boundary, not a substitute for plugin leases.

## Hot replacement

When a Profile or package revision changes, Plugin Kernel:

1. reads and validates v2 Manifest/Profile;
2. builds the capability graph and rejects missing dependencies or cycles;
3. prepares candidates by execution mode without importing `isolated` top-level code into Manager;
4. validates `readyRequires`, permissions, and contributions;
5. atomically commits the candidate generation so new requests enter only the new graph;
6. drains old requests, then disposes old consumers before providers and reclaims leases.

A failed candidate cannot contaminate the current generation or leave half-active services and processes. Unchanged instances whose dependencies are unchanged may be retained; replacing a provider also replaces affected consumers.

## Author gates

Trusted Manager packages may use the shared SDK, Node built-ins, and package-local `./` modules. Entry checks reject other bare dependencies, cross-package paths and symbolic links. This is not a JavaScript sandbox: execution modes and host capabilities remain the authority boundary. Implementation modules ship with the package and must not import the source checkout.

```powershell
npm test
npm run build
npm run check:config
```

New plugins must also prove: non-v2 schemas are rejected; Manager loader never runs `isolated` top-level code; missing `readyRequires` prevents Manager ready; consumers stop before providers; leases reach zero after reload, failure, and Manager shutdown; Desktop/Web consume declarations without acquiring application-lifecycle authority.
