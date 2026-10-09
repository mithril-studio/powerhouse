# Readable agent chat verification

## Scope

Conductor-inspired warm neutral shell, readable Markdown chat, embedded ACP image
results, and visible composer controls. Worktree lifecycle, notifications, review
workflow, and user image uploads are unchanged.

## Automated checks

- `pnpm test`: 67 tests pass, including image safety/order/replay, Markdown output
  and unsafe-content handling, visible tool images, and composer control states.
- `pnpm build`: passes; Vite still reports a large main bundle warning.
- `pnpm audit --prod`: no known vulnerabilities.
- Both existing lockfiles were updated; release CI uses the pnpm lockfile.

## Browser checks

An isolated Vite fixture rendered the real Sidebar, TabBar, AcpTranscript, and
AcpComposer components with synthetic agent output. Headless Chromium checks passed:

1. Render headings, lists and fenced code with a copy control.
2. Render an embedded raster image, enlarge it, and close with Escape.
3. Enter five lines; the composer grows to fit.
4. Send a message; Stop appears while working.
5. Draft a follow-up while busy; Enter does not send it.
6. Click Stop; the follow-up stays intact and is not submitted.
7. Switch between light and dark themes.
8. At 768, 900 and 1364px widths, no document-level horizontal overflow and the
   send control remains visible.
9. No browser JavaScript errors.

The Stop regression is important: Stop and Send need different React keys. If the
same DOM button is reused, its type can change to submit during the Stop click,
allowing the browser default action to send the draft unintentionally.

These checks do not replace a native Tauri walkthrough: actual adapter image
emission, native external-link opening, and restarting with persisted images still
need smoke testing with Claude/Codex/Pi. The fixture used no live agents or user data.
CodeRabbit review could not run because the local CLI requires authentication.

## Image contract and limitations

- Supported: ACP `image` blocks in assistant/user-replay content and tool results.
- Accepted raster MIME types: PNG, JPEG, GIF and WebP; at most 8 MiB of base64 per
  image (approximately 6 MiB decoded).
- Invalid/unsupported pictures show an unavailable message.
- Tool images stay visible outside their collapsed tool disclosure.
- Markdown HTML is ignored. Remote images are not fetched automatically. Web links
  open through the existing native opener on explicit user activation.
- No arbitrary filesystem reads, image-upload flow, syntax highlighting, or image
  asset cache was added. Base64 images use the existing transcript persistence;
  image-heavy histories will make that store larger.
