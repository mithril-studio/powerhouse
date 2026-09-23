import { timingSafeEqual } from "node:crypto";

import type { OwnerToken } from "./config.js";

function equalConstantTime(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  // Length leak is acceptable; content comparison is constant-time.
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Resolve an Authorization header to an owner, or null when unauthorized. */
export function authenticate(tokens: OwnerToken[], header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/.exec(header);
  if (!match) return null;
  const presented = match[1]!.trim();
  for (const { owner, token } of tokens) {
    if (equalConstantTime(token, presented)) return owner;
  }
  return null;
}
