# Chat presentation

The workspace uses warm neutral colors, sans-serif prose, a constrained reading
column, and a multiline composer inspired by Conductor. Markdown supports headings,
lists, tables, fenced code and copy buttons. Send and Stop are visible; users can
draft while an agent works. Drafts are still runtime-only.

This integrates onto the current `test` implementation, preserving image uploads,
cloud workspaces, context usage, activity indicators, grouped tools and file tabs.
It extends the existing AcpMarkdown and attachment cache rather than adding a
second transcript format or persisting image bytes in the desktop JSON store.

Agent attachments and tool-result image blocks get inline previews with an
accessible native-dialog enlargement. Tool images remain visible when the group
is collapsed. Previews accept embedded PNG/JPEG/GIF/WebP up to 8 MiB of base64
(about 6 MiB decoded); unsupported or unavailable images show a fallback. Existing
attachment references survive restart, but the pixels need an agent replay as
before. Remote Markdown images and local file paths are not automatically fetched.

Verified on integration: `pnpm test` (154 tests) and `pnpm build`. Tests cover safe
Markdown, image validation, collapsed-tool previews and busy composer controls.
The originating UI slice also passed Chromium interaction/layout checks. Native
adapter image emission and actual cloud execution are not exercised by these tests.

Keep separate React keys for Send and Stop: reusing the DOM button can change its
type to submit during a Stop click and inadvertently send the waiting draft.
