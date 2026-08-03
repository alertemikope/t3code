import {
  EnvironmentId,
  ProjectId,
  type OrchestrationArchivedProjectsSnapshot,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { expect, it } from "vite-plus/test";

import {
  createArchivedProjectsSnapshotsAtomFamily,
  makeArchivedProjectsEnvironmentKey,
  parseArchivedProjectsEnvironmentKey,
} from "./archivedProjects.ts";

it("round-trips hidden-project environment keys in sorted order", () => {
  const envA = EnvironmentId.make("env-a");
  const envB = EnvironmentId.make("env-b");
  const key = makeArchivedProjectsEnvironmentKey([envB, envA]);

  expect(parseArchivedProjectsEnvironmentKey(key)).toEqual([envA, envB]);
});

it("combines hidden-project snapshots without exposing failure details", () => {
  const envA = EnvironmentId.make("env-a");
  const envB = EnvironmentId.make("env-b");
  const snapshot: OrchestrationArchivedProjectsSnapshot = {
    snapshotSequence: 3,
    projects: [
      {
        id: ProjectId.make("project-hidden"),
        title: "Hidden project",
        workspaceRoot: "/tmp/project-hidden",
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
        archivedAt: "2026-01-02T00:00:00.000Z",
      },
    ],
    updatedAt: "2026-01-02T00:00:00.000Z",
  };
  const snapshotsAtom = createArchivedProjectsSnapshotsAtomFamily<Error>({
    getSnapshotAtom: (environmentId) =>
      environmentId === envA
        ? Atom.make(AsyncResult.success(snapshot))
        : Atom.make(
            AsyncResult.failure<OrchestrationArchivedProjectsSnapshot, Error>(
              Cause.fail(new Error("credential=secret-value")),
            ),
          ),
    labelPrefix: "test:hidden-project-snapshots",
  });
  const registry = AtomRegistry.make();

  expect(registry.get(snapshotsAtom(makeArchivedProjectsEnvironmentKey([envB, envA])))).toEqual({
    snapshots: [{ environmentId: envA, snapshot }],
    error: "Failed to load hidden projects.",
    isLoading: false,
  });

  registry.dispose();
});
