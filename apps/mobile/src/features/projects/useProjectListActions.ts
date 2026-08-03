import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import * as Haptics from "expo-haptics";
import { useCallback, useRef } from "react";
import { Alert } from "react-native";

import { showConfirmDialog } from "../../components/ConfirmDialogHost";
import { scopedProjectKey } from "../../lib/scopedEntities";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { refreshArchivedProjectsForEnvironment } from "../archive/useArchivedProjectSnapshots";
import { refreshArchivedThreadsForEnvironment } from "../archive/useArchivedThreadSnapshots";

function projectActionHaptic(): void {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
}

export function useProjectListActions() {
  const archiveProject = useAtomCommand(projectEnvironment.archive, { reportFailure: false });
  const unarchiveProject = useAtomCommand(projectEnvironment.unarchive, { reportFailure: false });
  const deleteProject = useAtomCommand(projectEnvironment.delete, { reportFailure: false });
  const inFlightProjectKeys = useRef(new Set<string>());

  const runProjectAction = useCallback(
    async (action: "hide" | "restore" | "remove", project: EnvironmentProject) => {
      const key = scopedProjectKey(project.environmentId, project.id);
      if (inFlightProjectKeys.current.has(key)) return false;
      inFlightProjectKeys.current.add(key);
      projectActionHaptic();

      try {
        const result = await (action === "hide"
          ? archiveProject({
              environmentId: project.environmentId,
              input: { projectId: project.id },
            })
          : action === "restore"
            ? unarchiveProject({
                environmentId: project.environmentId,
                input: { projectId: project.id },
              })
            : deleteProject({
                environmentId: project.environmentId,
                input: { projectId: project.id, force: true },
              }));
        if (result._tag === "Failure") {
          Alert.alert(
            action === "hide"
              ? "Could not hide project"
              : action === "restore"
                ? "Could not restore project"
                : "Could not remove project",
            "The project action did not complete. Try again.",
          );
          return false;
        }

        refreshArchivedProjectsForEnvironment(project.environmentId);
        if (action === "remove") {
          refreshArchivedThreadsForEnvironment(project.environmentId);
        }
        return true;
      } finally {
        inFlightProjectKeys.current.delete(key);
      }
    },
    [archiveProject, deleteProject, unarchiveProject],
  );

  const hideProjects = useCallback(
    async (projects: ReadonlyArray<EnvironmentProject>) => {
      for (const project of projects) {
        if (!(await runProjectAction("hide", project))) return false;
      }
      return true;
    },
    [runProjectAction],
  );

  const restoreProject = useCallback(
    (project: EnvironmentProject) => runProjectAction("restore", project),
    [runProjectAction],
  );

  const confirmRemoveProject = useCallback(
    (project: EnvironmentProject) => {
      const title = "Remove project permanently?";
      const message = `“${project.title}” and its conversation history will be deleted. Files on disk are not removed.`;
      const remove = () => void runProjectAction("remove", project);
      if (process.env.EXPO_OS === "ios") {
        Alert.alert(title, message, [
          { text: "Cancel", style: "cancel" },
          { text: "Remove", style: "destructive", onPress: remove },
        ]);
        return;
      }
      showConfirmDialog({
        title,
        message,
        confirmText: "Remove",
        destructive: true,
        onConfirm: remove,
      });
    },
    [runProjectAction],
  );

  return { confirmRemoveProject, hideProjects, restoreProject };
}
