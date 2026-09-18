import { describe, expect, it } from "vitest";
import {
  migrateSettings,
  resolveChatTransport,
  type AgentProfile,
  type Settings,
} from "./appStore";

describe("agent transport migration", () => {
  it("backfills ACP settings for known agents and adds new seed agents", () => {
    const claude: AgentProfile = {
      id: "claude",
      name: "Claude",
      command: "claude-custom",
      promptTemplate: 'claude-custom "{prompt}"',
    };

    const settings = migrateSettings({
      settings: { agents: [claude], defaultAgentId: "claude" },
    });

    expect(settings.agents.find((agent) => agent.id === "claude")).toEqual(
      expect.objectContaining({ command: "claude-custom", transport: "acp" }),
    );
    expect(settings.agents.find((agent) => agent.id === "opencode")).toEqual(
      expect.objectContaining({ transport: "acp", command: "opencode" }),
    );
  });

  it("keeps custom agents on the terminal transport", () => {
    const settings: Settings = {
      defaultAgentId: "custom",
      agents: [
        {
          id: "custom",
          name: "Custom",
          command: "my-agent",
          promptTemplate: 'my-agent "{prompt}"',
        },
      ],
    };

    expect(resolveChatTransport(settings, {})).toBe("pty");
  });

  it("lets a chat override its agent transport", () => {
    const settings = migrateSettings(null);

    expect(
      resolveChatTransport(settings, {
        agentId: "claude",
        transport: "pty",
      }),
    ).toBe("pty");
  });
});
