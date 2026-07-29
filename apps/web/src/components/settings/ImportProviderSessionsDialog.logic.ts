import type {
  EnvironmentId,
  ProjectId,
  ProviderNativeSession,
  ServerProvider,
} from "@t3tools/contracts";

const NATIVE_SESSION_DRIVERS = new Set(["ocean", "piAgent"]);

export interface NativeSessionProject {
  readonly id: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
}

function normalizePath(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "/") return trimmed;
  return trimmed.replace(/\/+$/u, "");
}

export function nativeSessionBelongsToWorkspace(cwd: string, workspaceRoot: string): boolean {
  const sessionPath = normalizePath(cwd);
  const projectPath = normalizePath(workspaceRoot);
  return sessionPath === projectPath || sessionPath.startsWith(`${projectPath}/`);
}

/**
 * Keep only sessions owned by a project, de-duplicate provider results, and
 * create the oldest entries first so the newest native conversation remains
 * the newest T3 thread after a bulk import.
 */
export function nativeSessionsForWorkspace(
  sessions: ReadonlyArray<ProviderNativeSession>,
  workspaceRoot: string,
): ReadonlyArray<ProviderNativeSession> {
  const seen = new Set<string>();
  return sessions
    .filter((session) => {
      if (
        seen.has(session.sessionId) ||
        !nativeSessionBelongsToWorkspace(session.cwd, workspaceRoot)
      ) {
        return false;
      }
      seen.add(session.sessionId);
      return true;
    })
    .toSorted(
      (left, right) =>
        (left.updatedAt ?? "").localeCompare(right.updatedAt ?? "") ||
        left.sessionId.localeCompare(right.sessionId),
    );
}

export function importableNativeSessionProviders(
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ServerProvider> {
  return providers.filter(
    (provider) =>
      NATIVE_SESSION_DRIVERS.has(provider.driver) &&
      provider.enabled &&
      provider.installed &&
      provider.status === "ready" &&
      provider.availability !== "unavailable",
  );
}

export function nativeSessionTitle(session: ProviderNativeSession): string {
  const title = session.title?.trim();
  if (title) return title;
  const path = normalizePath(session.cwd);
  const basename = path.split("/").filter(Boolean).at(-1);
  return basename ? `${basename} · ${session.sessionId.slice(0, 8)}` : session.sessionId;
}

/**
 * Prefer an exact workspace, then the longest project root containing the
 * native session cwd. This keeps an imported Ocean/Pi conversation grouped
 * with the T3 project it actually belongs to.
 */
export function resolveNativeSessionProject(
  cwd: string,
  projects: ReadonlyArray<NativeSessionProject>,
  environmentId: EnvironmentId,
  fallbackProjectId?: ProjectId,
): ProjectId | null {
  const sessionPath = normalizePath(cwd);
  const candidates = projects
    .filter((project) => project.environmentId === environmentId)
    .map((project) => ({ project, path: normalizePath(project.workspaceRoot) }))
    .filter(({ path }) => nativeSessionBelongsToWorkspace(sessionPath, path))
    .toSorted((left, right) => right.path.length - left.path.length);
  if (candidates[0]) return candidates[0].project.id;
  if (
    fallbackProjectId &&
    projects.some(
      (project) => project.environmentId === environmentId && project.id === fallbackProjectId,
    )
  ) {
    return fallbackProjectId;
  }
  return projects.find((project) => project.environmentId === environmentId)?.id ?? null;
}
