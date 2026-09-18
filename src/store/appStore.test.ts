import { describe, expect, it } from "vitest";
import {
  migrateSettings,
  resolveChatTransport,
  type AgentProfile,
  type Settings,
} from "./appStore";

describe("agent transport migration", () => {
  it("backfills ACP settings and removes the retired OpenCode seed profile", () => {
    const claude: AgentProfile = {
      id: "claude",
      name: "Claude",
      command: "claude-custom",
      promptTemplate: 'claude-custom "{prompt}"',
    };

    const opencode: AgentProfile = {
      id: "opencode",
      name: "OpenCode",
      command: "opencode",
      promptTemplate: 'opencode "{prompt}"',
    };

    const settings = migrateSettings({
      settings: {
        agents: [claude, opencode],
        defaultAgentId: "opencode",
        theme: "dark",
        connections: { github: { status: "disconnected" } },
      },
    });

    expect(settings.agents.find((agent) => agent.id === "claude")).toEqual(
      expect.objectContaining({ command: "claude-custom", transport: "acp" }),
    );
    expect(settings.agents.find((agent) => agent.id === "opencode")).toBeUndefined();
    expect(settings.defaultAgentId).toBe("claude");
    expect(settings.agents.map((agent) => agent.id)).toEqual(["claude", "codex", "pi"]);
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
      theme: "dark",
      connections: { github: { status: "disconnected" } },
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
