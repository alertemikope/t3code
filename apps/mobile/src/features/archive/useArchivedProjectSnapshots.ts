import { useAtomValue } from "@effect/atom-react";
import {
  type ArchivedProjectsSnapshotEntry,
  createArchivedProjectsSnapshotsAtomFamily,
  makeArchivedProjectsEnvironmentKey,
} from "@t3tools/client-runtime/state/projects";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import { appAtomRegistry } from "../../state/atom-registry";
import { orchestrationEnvironment } from "../../state/orchestration";

function archivedProjectsSnapshotAtom(environmentId: EnvironmentId) {
  return orchestrationEnvironment.archivedProjectsSnapshot({
    environmentId,
    input: {},
  });
}

const archivedProjectsSnapshotsAtom = createArchivedProjectsSnapshotsAtomFamily({
  getSnapshotAtom: archivedProjectsSnapshotAtom,
  labelPrefix: "mobile:archived-project-snapshots",
});

export function refreshArchivedProjectsForEnvironment(environmentId: EnvironmentId): void {
  appAtomRegistry.refresh(archivedProjectsSnapshotAtom(environmentId));
}

export function useArchivedProjectSnapshots(environmentIds: ReadonlyArray<EnvironmentId>): {
  readonly snapshots: ReadonlyArray<ArchivedProjectsSnapshotEntry>;
  readonly error: string | null;
  readonly isLoading: boolean;
  readonly refresh: () => void;
} {
  const environmentKey = useMemo(
    () => makeArchivedProjectsEnvironmentKey(environmentIds),
    [environmentIds],
  );
  const result = useAtomValue(archivedProjectsSnapshotsAtom(environmentKey));
  const refresh = useCallback(() => {
    for (const environmentId of environmentIds) {
      appAtomRegistry.refresh(archivedProjectsSnapshotAtom(environmentId));
    }
  }, [environmentIds]);

  return { ...result, refresh };
}
