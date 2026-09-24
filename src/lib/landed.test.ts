import { describe, expect, it } from "vitest";
import { landedHeading, landedStatus } from "./landed";

describe("landed list copy", () => {
  it("names the range when a base exists and the tip otherwise", () => {
    expect(landedHeading("test", "main")).toBe("On test since main");
    expect(landedHeading("main", null)).toBe("Latest on main");
  });

  it("pluralises and flags a failed fetch", () => {
    expect(landedStatus(1, true)).toBe("1 commit");
    expect(landedStatus(0, true)).toBe("0 commits");
    expect(landedStatus(3, false)).toBe("3 commits · fetch failed, showing last known");
  });
});
