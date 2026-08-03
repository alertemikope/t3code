import type { EnvironmentId } from "@t3tools/contracts";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useMemo, useState } from "react";

import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { useClerkSettingsSheetDetent } from "../cloud/ClerkSettingsSheetDetent";
import { useArchivedThreadListActions } from "../home/useThreadListActions";
import { useProjectListActions } from "../projects/useProjectListActions";
import {
  ArchivedThreadsScreen,
  type ArchivedThreadsHeaderEnvironment,
} from "./ArchivedThreadsScreen";
import { buildArchivedThreadGroups, type ArchivedThreadSortOrder } from "./archivedThreadList";
import { buildArchivedProjectList } from "./archivedProjectList";
import {
  refreshArchivedThreadsForEnvironment,
  useArchivedThreadSnapshots,
} from "./useArchivedThreadSnapshots";
import { useArchivedProjectSnapshots } from "./useArchivedProjectSnapshots";

export function ArchivedThreadsRouteScreen() {
  const { expand } = useClerkSettingsSheetDetent();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<EnvironmentId | null>(null);
  const [sortOrder, setSortOrder] = useState<ArchivedThreadSortOrder>("newest");
  const environments = useMemo<ReadonlyArray<ArchivedThreadsHeaderEnvironment>>(
    () =>
      Arr.sort(
        Object.values(savedConnectionsById).map((connection) => ({
          environmentId: connection.environmentId,
          label: connection.environmentLabel,
        })),
        Order.mapInput(Order.String, (environment: ArchivedThreadsHeaderEnvironment) =>
          environment.label.toLocaleLowerCase(),
        ),
      ),
    [savedConnectionsById],
  );
  const environmentIds = useMemo(
    () => environments.map((environment) => environment.environmentId),
    [environments],
  );
  const environmentLabels = useMemo(
    () =>
      Object.fromEntries(
        environments.map((environment) => [environment.environmentId, environment.label]),
      ),
    [environments],
  );
  const { error, isLoading, refresh, snapshots } = useArchivedThreadSnapshots(environmentIds);
  const {
    error: archivedProjectsError,
    isLoading: isLoadingArchivedProjects,
    refresh: refreshArchivedProjects,
    snapshots: archivedProjectSnapshots,
  } = useArchivedProjectSnapshots(environmentIds);
  const groups = useMemo(
    () =>
      buildArchivedThreadGroups({
        snapshots,
        environmentLabels,
        environmentId: selectedEnvironmentId,
        searchQuery,
        sortOrder,
      }),
    [environmentLabels, searchQuery, selectedEnvironmentId, snapshots, sortOrder],
  );
  const archivedProjects = useMemo(
    () =>
      buildArchivedProjectList({
        snapshots: archivedProjectSnapshots,
        environmentLabels,
        environmentId: selectedEnvironmentId,
        searchQuery,
        sortOrder,
      }),
    [archivedProjectSnapshots, environmentLabels, searchQuery, selectedEnvironmentId, sortOrder],
  );
  const refreshArchive = useCallback(() => {
    refresh();
    refreshArchivedProjects();
  }, [refresh, refreshArchivedProjects]);
  const refreshChangedEnvironment = useCallback(
    (thread: { readonly environmentId: EnvironmentId }) => {
      refreshArchivedThreadsForEnvironment(thread.environmentId);
    },
    [],
  );
  const { unarchiveThread, confirmDeleteThread } =
    useArchivedThreadListActions(refreshChangedEnvironment);
  const { confirmRemoveProject, restoreProject } = useProjectListActions();

  useFocusEffect(
    useCallback(() => {
      expand();
      refreshArchive();
    }, [expand, refreshArchive]),
  );

  return (
    <ArchivedThreadsScreen
      environments={environments}
      archivedProjects={archivedProjects}
      error={error ?? archivedProjectsError}
      groups={groups}
      isLoading={isLoading || isLoadingArchivedProjects}
      onRemoveProject={confirmRemoveProject}
      onDeleteThread={confirmDeleteThread}
      onEnvironmentChange={setSelectedEnvironmentId}
      onRefresh={refreshArchive}
      onRestoreProject={(project) => void restoreProject(project)}
      onSearchQueryChange={setSearchQuery}
      onSortOrderChange={setSortOrder}
      onUnarchiveThread={unarchiveThread}
      searchQuery={searchQuery}
      selectedEnvironmentId={selectedEnvironmentId}
      sortOrder={sortOrder}
    />
  );
}
