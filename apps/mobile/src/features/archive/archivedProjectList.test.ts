import type { ArchivedProjectsSnapshotEntry } from "@t3tools/client-runtime/state/projects";
import type { OrchestrationProjectShell } from "@t3tools/contracts";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildArchivedProjectList } from "./archivedProjectList";

const environmentA = EnvironmentId.make("environment-a");
const environmentB = EnvironmentId.make("environment-b");

function makeProject(
  input: Partial<OrchestrationProjectShell> & Pick<OrchestrationProjectShell, "id" | "title">,
): OrchestrationProjectShell {
  return {
    workspaceRoot: `/workspaces/${input.id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    archivedAt: "2026-06-02T00:00:00.000Z",
    ...input,
  };
}

function makeSnapshot(
  environmentId: EnvironmentId,
  projects: ReadonlyArray<OrchestrationProjectShell>,
): ArchivedProjectsSnapshotEntry {
  return {
    environmentId,
    snapshot: {
      snapshotSequence: 1,
      projects,
      updatedAt: "2026-06-04T00:00:00.000Z",
    },
  };
}

describe("buildArchivedProjectList", () => {
  it("keeps duplicate project ids scoped by environment and sorts newest first", () => {
    const result = buildArchivedProjectList({
      snapshots: [
        makeSnapshot(environmentA, [makeProject({ id: ProjectId.make("shared"), title: "Older" })]),
        makeSnapshot(environmentB, [
          makeProject({
            id: ProjectId.make("shared"),
            title: "Newer",
            archivedAt: "2026-06-03T00:00:00.000Z",
          }),
        ]),
      ],
      environmentLabels: { [environmentA]: "Laptop", [environmentB]: "Server" },
      environmentId: null,
      searchQuery: "",
      sortOrder: "newest",
    });

    expect(
      result.map(({ environmentLabel, project }) => [environmentLabel, project.title]),
    ).toEqual([
      ["Server", "Newer"],
      ["Laptop", "Older"],
    ]);
  });

  it("filters by environment and excludes non-hidden projects", () => {
    const result = buildArchivedProjectList({
      snapshots: [
        makeSnapshot(environmentA, [
          makeProject({ id: ProjectId.make("visible"), title: "Visible", archivedAt: null }),
          makeProject({ id: ProjectId.make("hidden"), title: "Hidden" }),
        ]),
        makeSnapshot(environmentB, [makeProject({ id: ProjectId.make("other"), title: "Other" })]),
      ],
      environmentLabels: { [environmentA]: "Laptop", [environmentB]: "Server" },
      environmentId: environmentA,
      searchQuery: "hidden",
      sortOrder: "oldest",
    });

    expect(result.map(({ project }) => project.id)).toEqual(["hidden"]);
  });
});
