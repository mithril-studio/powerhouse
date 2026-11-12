# Workflow authoring increment

The Workflows page now supports project filtering, independent copies of project
merge checks, unique default names, duplication, deletion with Undo, and actionable
validation errors. Drafts still use the existing desktop store and are saved even
when incomplete. Imported commands and their order are preserved; import never
runs checks, changes merge behavior, enables pushing, or drops excess steps.

Validation follows the coordinator's published sequence contract: 1–10 steps,
unique kebab-case node names (at most 64 characters), and nonempty commands without
NULs, capped conservatively at 64 KiB of UTF-8. This is separate from the local
merge queue's 16-step contract. Invalid persisted drafts are not silently rewritten.

Draft validity is not publication or readiness to execute. The page explicitly
says execution is not connected; it no longer presents placeholder run history as
if it were fetched from the coordinator.

## Verification

- `pnpm test`: 162 passing tests, covering validation, copying without mutation,
  preservation of oversized imports, deletion/restoration, hydration, and editor
  states alongside the existing suite.
- Chromium fixture using the real Workflows page: import merge checks, duplicate,
  delete/Undo, reorder while retaining selection, focus a validation error, filter
  projects, create in the filtered project, reassign while retaining selection,
  enforce the 10-step add limit, and render light/dark at 768/1024/1440px without
  document overflow. No JavaScript errors.
- No remote jobs, infrastructure, or authentication changes in this increment.

## Next execution slice

The existing `server/` already supports workflow creation, immutable versions,
owner-authenticated run admission, run inspection, and cancellation. Reuse it.

1. Add a desktop coordinator connection: HTTPS endpoint and token kept in the
   native credential store, not in drafts or renderer persistence. Confirm the
   target endpoint and credential provisioning before wiring this up.
2. Resolve an explicit remote repository, runner snapshot and pushed commit.
   Never silently push local changes to make a run work.
3. Publish a valid draft, retaining its server workflow/version identity. Admit
   a run with a stable idempotency key so a lost response cannot launch twice.
4. Render run/node states and logs; reconnect after closing the page/app. Add
   owner-scoped run history listing to the server (it currently exposes individual
   run lookup but no workflow-run listing).
5. Cancel through the coordinator and show canceling until the runner stops.

The workflow coordinator, rather than a desktop polling loop, owns execution and
resource cleanup. A sequence's steps currently use separate checkouts, so outputs
are not implicitly shared between scripts.
