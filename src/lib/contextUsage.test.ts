import { describe, expect, it } from "vitest";
import { describeContextUsage } from "./contextUsage";

describe("describeContextUsage", () => {
  it("reports share of the window and formatted tokens", () => {
    const view = describeContextUsage(71_200, 200_000);
    expect(view.percent).toBe(36);
    expect(view.percentLabel).toBe("36%");
    expect(view.tokens).toBe("71.2k / 200.0k");
    expect(view.level).toBe("ok");
  });

  it("escalates tone as the window fills", () => {
    expect(describeContextUsage(140_000, 200_000).level).toBe("warn");
    expect(describeContextUsage(190_000, 200_000).level).toBe("critical");
  });

  it("clamps readings that exceed the reported window", () => {
    const view = describeContextUsage(250_000, 200_000);
    expect(view.fraction).toBe(1);
    expect(view.percent).toBe(100);
  });

  it("degrades gracefully when the agent does not know the window size", () => {
    const view = describeContextUsage(12_000, 0);
    expect(view.percentLabel).toBe("—");
    expect(view.tokens).toBe("12.0k / ?");
    expect(view.level).toBe("ok");
  });
});
