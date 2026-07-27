import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderNativeSession,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  importableNativeSessionProviders,
  nativeSessionTitle,
  resolveNativeSessionProject,
} from "./ImportProviderSessionsDialog.logic";

const environmentId = EnvironmentId.make("environment-local");

function provider(driver: string, input: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(driver),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-07-27T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...input,
  };
}

describe("native provider session import", () => {
  it("only exposes live Ocean and Pi instances", () => {
    expect(
      importableNativeSessionProviders([
        provider("ocean"),
        provider("piAgent"),
        provider("codex"),
        provider("ocean", { instanceId: ProviderInstanceId.make("ocean_off"), enabled: false }),
      ]).map((entry) => entry.instanceId),
    ).toEqual(["ocean", "piAgent"]);
  });

  it("selects the most specific project containing the session cwd", () => {
    const root = ProjectId.make("project-root");
    const nested = ProjectId.make("project-nested");
    expect(
      resolveNativeSessionProject(
        "/work/mono/apps/web",
        [
          { id: root, environmentId, workspaceRoot: "/work/mono" },
          { id: nested, environmentId, workspaceRoot: "/work/mono/apps" },
        ],
        environmentId,
      ),
    ).toBe(nested);
  });

  it("uses the native title, then a useful cwd fallback", () => {
    const session = {
      provider: ProviderDriverKind.make("ocean"),
      providerInstanceId: ProviderInstanceId.make("ocean"),
      sessionId: "abcdef123456",
      cwd: "/work/media/jellyfin/",
    } satisfies ProviderNativeSession;
    expect(nativeSessionTitle({ ...session, title: "Jellyfin indexing" })).toBe(
      "Jellyfin indexing",
    );
    expect(nativeSessionTitle(session)).toBe("jellyfin · abcdef12");
  });
});
