import type { ArchivedProjectsSnapshotEntry } from "@t3tools/client-runtime/state/projects";
import { scopeProject, type EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";

export interface ArchivedProjectListEntry {
  readonly environmentLabel: string | null;
  readonly project: EnvironmentProject;
}

function archivedAtTimestamp(project: EnvironmentProject): number {
  const timestamp = Date.parse(project.archivedAt ?? project.updatedAt);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function matchesQuery(value: string | null, query: string): boolean {
  return value?.toLocaleLowerCase().includes(query) ?? false;
}

export function buildArchivedProjectList(input: {
  readonly snapshots: ReadonlyArray<ArchivedProjectsSnapshotEntry>;
  readonly environmentLabels: Readonly<Record<string, string>>;
  readonly environmentId: EnvironmentId | null;
  readonly searchQuery: string;
  readonly sortOrder: "newest" | "oldest";
}): ReadonlyArray<ArchivedProjectListEntry> {
  const query = input.searchQuery.trim().toLocaleLowerCase();
  const entries: ArchivedProjectListEntry[] = [];

  for (const entry of input.snapshots) {
    if (input.environmentId !== null && input.environmentId !== entry.environmentId) continue;
    const environmentLabel = input.environmentLabels[entry.environmentId] ?? null;

    for (const rawProject of entry.snapshot.projects) {
      if (rawProject.archivedAt === null) continue;
      const project = scopeProject(entry.environmentId, rawProject);
      if (
        query.length > 0 &&
        !matchesQuery(project.title, query) &&
        !matchesQuery(project.workspaceRoot, query) &&
        !matchesQuery(environmentLabel, query)
      ) {
        continue;
      }
      entries.push({ environmentLabel, project });
    }
  }

  const timestampOrder = input.sortOrder === "newest" ? Order.flip(Order.Number) : Order.Number;
  return Arr.sort(
    entries,
    Order.mapInput(
      Order.Struct({ timestamp: timestampOrder, title: Order.String, key: Order.String }),
      (entry: ArchivedProjectListEntry) => ({
        timestamp: archivedAtTimestamp(entry.project),
        title: entry.project.title,
        key: `${entry.project.environmentId}:${entry.project.id}`,
      }),
    ),
  );
}
