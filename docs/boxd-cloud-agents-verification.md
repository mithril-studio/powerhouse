# Cloud agents: execution evidence

## Status

2026-09-19: slice 0 is blocked on boxd VM boot. Local baseline, CLI capability
inspection, and a process test fixture are ready. No cloud agent feature has been implemented, and no
detached cloud execution has been verified. Slices 1–6 remain pending.

The user approved the proposed resource setup in this session. Provisioning
started at 2026-09-18 23:32 UTC (2026-09-19 in Europe/Amsterdam). The cloud
capability proof could not run; no credential has been copied or configured.

Provisioning receipt: `powerhouse-cloud-base`, stable ID
`5a943507-3186-464c-b9f0-51f21f58c684`. Created private with `--isolated`,
auto-suspend 300 seconds, and auto-hibernate 900 seconds. The create response
reported `boot: timeout`; reconcile this identity instead of creating another VM.

Recovery: reboot and then a stop/start cycle both left the same VM in `starting`;
three runtime probes failed with wake timeouts (`pending`, then `starting`).
The single approved fork attempt, `powerhouse-cloud-spike` from the stopped
base, failed with `error: couldn't fork that machine`. A subsequent get returned
`VM 'powerhouse-cloud-spike' not found`, and inventory confirmed no fork exists.
No new machine or unrelated environment was substituted.

At 2026-09-18 23:42 UTC the base was confirmed **stopped**, with its disk retained.
It is the only new resource. Its configured idle values remain 300/900 seconds;
both were never disabled. No model call or repository upload occurred. The
failure is at the provisioning/boot layer, before any Powerhouse code ran; the
underlying platform cause is not known.

## Local baseline

Source: `db2b7c51b4cb9f64816e15675f2453fdb86a977f` on `main`.
Host: macOS, arm64. The existing untracked `docs/` files were preserved.

| Command | Observed result |
| --- | --- |
| `pnpm build` | Pass; existing warning about a JavaScript chunk larger than 500 kB. |
| `cargo test --manifest-path src-tauri/Cargo.toml` | Pass; **zero tests** in the existing Rust suite. |
| `cargo check --manifest-path src-tauri/Cargo.toml` | Pass. |
| `boxd version` | `boxd 0.2.9`. |
| `claude --version` | `2.1.277 (Claude Code)`, on the laptop only. |

No frontend test script currently exists. These checks establish a starting
point; they provide no evidence of Linux supervision or cloud durability.

## Installed CLI observations

The installed help, rather than older skill examples, established these forms:

```sh
boxd version
boxd auth --json
boxd manage billing --json
boxd machine list --json
boxd machine get VM --json
boxd machine fork VM NAME --isolated --auto-suspend-timeout 0 --auto-hibernate-timeout 0 --json
boxd machine exec VM --timeout SECONDS -- COMMAND
boxd machine cp SOURCE DEST --json
boxd machine config set VM auto-suspend.timeout SECONDS --json
boxd machine config set VM auto-hibernate.timeout SECONDS --json
```

The initial inspection used only version/help, identity, billing, and inventory.
The later resource operations and their failures are recorded above. These syntax
references do not imply that execution, transfer, or idle restoration succeeded.
`boxd --version`, `boxd whoami`, and `boxd auth org` are rejected by this version.

- Actual machine-list entries contain `name`, `status`, `url`, `source`, and
  `sharing`; they do **not** contain the `vm_id` claimed by older skill examples.
  Capture and validate stable identity from real create/get responses during
  the approved spike; never substitute a display name for a durable VM ID.
- `boxd auth --json` returned account `gh-mithril-studio`, `active_org: null`,
  and an organization entry marked active. The separate billing query resolved
  the effective context to organization **mithril-studio**, with 8 of 20 VM
  slots occupied. A null top-level organization is not proof of personal billing.
- New/fork help exposes both idle timeouts and `--isolated`. Their actual
  effect, response schemas, and reconciliation behavior remain untested.
- API-key creation help exposes organization fencing and expiry, but no
  per-machine permission option. No key was created. Do not claim a root-owned
  organization key would be restricted to one machine by the platform.
- `exec` help does not promise stdin forwarding. Transfer manifests using `cp`
  and atomic finalization, as required by the brief.

## Capability risks to resolve on Linux

boxd documents that `--isolated` removes saved coding-agent logins, connected
integrations, the in-VM CLI, and the laptop bridge. It also excludes the default
private network. Isolation is inherited by descendants. Therefore automatic
cloud login and in-VM lifecycle access cannot be presumed on an isolated fork.
See [Sandboxes](https://docs.boxd.sh/use-cases/sandboxes).

Both idle timers observe inbound network activity, not CPU activity. They must
remain disabled while work is active. A timer inside a frozen VM cannot recover
the task. The supervisor's independent restoration mechanism still needs proof.
See [Suspend, resume, and hibernate](https://docs.boxd.sh/guides/suspend-resume).

Forks can copy running processes as well as disk and memory. A prepared base
must have no active task, and forked execution ownership must be initialized
deliberately. See [Fork](https://docs.boxd.sh/guides/fork).

Local Claude help supports `--print`, `--output-format stream-json`,
`--permission-mode dontAsk`, `--permission-prompts none`, `--allowedTools`, and
`--max-budget-usd`. These are candidate capabilities, not a verified adapter.
Verify the VM's installed version, actual denial/result events, and child-process
termination. No paid model call has been made.

`--bare` skips ambient customizations but requires API authentication rather
than a subscription login. The credential choice must precede selection of this
mode. Reported usage is an estimate, not an infrastructure billing cap. See
[Claude programmatic usage](https://code.claude.com/docs/en/headless).

## Approved spike resource setup

| Item | Proposal |
| --- | --- |
| Billing | Existing `mithril-studio` organization; private resources only. |
| Base | New dedicated `powerhouse-cloud-base`; do not reuse an unrelated application VM. |
| Capacity | Two new VMs maximum: one base and one test fork; one active task. |
| Repository | `mithril-studio/powerhouse`, exact source SHA recorded above; verify remote availability before execution. |
| Credentials | Explicitly configured cloud Claude and GitHub sources only; availability remains unverified. No laptop login-directory, SSH-key, or `.env` copies. |
| Limits | At most 60 minutes of active VM time for the spike, 15 minutes per run, and a $1 Claude API limit per model test. These are approved ceilings, not a total euro cost guarantee. The base was stopped about 10 minutes after provisioning started; no workload or model test ran. |
| Retention | Preserve the base, task VM, and artifacts; restore approved idle policies independently of the laptop; no automatic deletion. |

Credential availability and the trusted lifecycle capability still need verification.
Resolve the trusted lifecycle capability before disabling both idle policies for
detached work. If it requires credential provisioning, explain its actual scope
and obtain the approval required by the brief. Do not substitute a laptop-owned
cleanup timer or silently relax isolation.

Perform the spike in this order:

1. Create only the approved dedicated environment. Record stable IDs, effective
   billing/sharing/isolation, Linux architecture, systemd/cgroup support, and
   installed tool versions without secret values.
2. Establish the unprivileged agent identity and protected supervisor state.
   Audit inherited credential paths, privileged sockets, and platform access.
   Verify denials under the agent identity, not just environment filtering.
3. Prove an authorized, cloud-owned way to restore both idle policies. Verify
   effective settings and the cleanup path before any unattended run.
4. Submit a supervised fake workload that writes a deterministic artifact and
   spawns a child. Close the submitting connection before it finishes. Reattach
   later and verify durable evidence, single execution, and idle restoration.
5. Exercise cancellation, deadline expiry, and reboot/recovery on that test
   fork. Verify child termination and honest interruption without blind retry.
6. Using the approved credentials, verify exact-source read access, unique task
   branch publication, and bounded noninteractive Claude behavior. If publication
   credentials grant broader access, document that and seek explicit approval.

## Integration boundaries confirmed in the current source

- `src/store/persist.ts` writes after a 300 ms debounce. Submission identity needs
  a separate explicitly awaited durable write before remote side effects.
- `src/store/appStore.ts` converts live **local queue** entries to `interrupted`
  during hydration. Cloud runs need separate reconciliation semantics.
- `src/App.tsx`, `src-tauri/src/lib.rs`, and `src/lib/terminalRegistry.ts` own
  local PTY cleanup. Add cloud observation without connecting it to those kills.
- `Branch.worktreePath` is consumed by local Git and file operations. Remote
  workspaces need a separate reference; local import can create a new worktree
  only after the remote result SHA is verified.

## Outstanding verification

The fixture in `scripts/cloud-spike/` is ready for review and Linux execution.
It reserves a test ID before launching a transient systemd unit, runs a fake
agent under `DynamicUser` with restricted privileges, and writes the supervisor's
outcome through a root-owned `ExecStopPost` hook. It includes completion,
nonzero-exit, CPU-only deadline, and cancellation cases. It is not the production
runner and does not claim restart recovery or idle-policy restoration.

`bash -n` and Python AST parsing passed. The driver also rejects this macOS host
before attempting installation or launching a process. **No Linux behavior has
been tested.** The README gives the separate-connection procedure and the evidence
to collect once the approved machine can execute commands.

All remote scenarios in section 11 of the execution brief remain **not run**.
There are no real run IDs, task-fork IDs, provider sessions, result commits, or
laptop-off demonstration results to report. The retained base ID is recorded
above. Slice 0's exit condition has not been met. Resume by starting that same
base and verifying runtime access; do not blindly create another base. Then
continue the capability proof above before broad
implementation; keep the deferred roadmap out of this milestone.
