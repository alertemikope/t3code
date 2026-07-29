"use client";

import { useNavigate } from "@tanstack/react-router";
import {
  PROVIDER_DISPLAY_NAMES,
  type EnvironmentId,
  type ProjectId,
  type ProviderInstanceId,
  type ProviderNativeSession,
  type ServerProvider,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { LoaderIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { serverEnvironment } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { newThreadId } from "../../lib/utils";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  importableNativeSessionProviders,
  nativeSessionTitle,
  resolveNativeSessionProject,
  type NativeSessionProject,
} from "./ImportProviderSessionsDialog.logic";

const THINKING_LEVELS = [
  ["off", "Off"],
  ["minimal", "Minimal"],
  ["low", "Low"],
  ["medium", "Medium"],
  ["high", "High"],
  ["xhigh", "XHigh"],
] as const;

interface ImportProviderSessionsDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly projects: ReadonlyArray<
    NativeSessionProject & {
      readonly title: string;
    }
  >;
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function initialModel(provider: ServerProvider | undefined): string {
  return provider?.models.find((model) => model.isDefault)?.slug ?? provider?.models[0]?.slug ?? "";
}

export function ImportProviderSessionsDialog({
  open,
  onOpenChange,
  environmentId,
  providers,
  projects,
}: ImportProviderSessionsDialogProps) {
  const navigate = useNavigate();
  const listProviderSessions = useAtomCommand(serverEnvironment.listProviderSessions, {
    reportFailure: false,
  });
  const bindProviderSession = useAtomCommand(serverEnvironment.bindProviderSession, {
    reportFailure: false,
  });
  const createThread = useAtomCommand(threadEnvironment.create, { reportFailure: false });
  const deleteThread = useAtomCommand(threadEnvironment.delete, { reportFailure: false });
  const importableProviders = useMemo(
    () => importableNativeSessionProviders(providers),
    [providers],
  );
  const environmentProjects = useMemo(
    () => projects.filter((project) => project.environmentId === environmentId),
    [environmentId, projects],
  );
  const [providerInstanceId, setProviderInstanceId] = useState<ProviderInstanceId | null>(
    importableProviders[0]?.instanceId ?? null,
  );
  const activeProvider =
    importableProviders.find((provider) => provider.instanceId === providerInstanceId) ??
    importableProviders[0];
  const [sessions, setSessions] = useState<ReadonlyArray<ProviderNativeSession>>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<ProjectId | null>(environmentProjects[0]?.id ?? null);
  const [model, setModel] = useState(() => initialModel(activeProvider));
  const [thinking, setThinking] = useState<(typeof THINKING_LEVELS)[number][0]>("high");
  const [isLoading, setIsLoading] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSequence = useRef(0);

  const selectedSession =
    sessions.find((session) => session.sessionId === selectedSessionId) ?? sessions[0] ?? null;

  const refreshSessions = useCallback(async () => {
    const instanceId = activeProvider?.instanceId;
    if (!instanceId) {
      setSessions([]);
      setSelectedSessionId(null);
      return;
    }
    const sequence = requestSequence.current + 1;
    requestSequence.current = sequence;
    setIsLoading(true);
    setError(null);
    const result = await listProviderSessions({
      environmentId,
      input: { providerInstanceId: instanceId },
    });
    if (requestSequence.current !== sequence) return;
    setIsLoading(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        setError(failureMessage(squashAtomCommandFailure(result)));
      }
      setSessions([]);
      setSelectedSessionId(null);
      return;
    }
    const sorted = result.value.sessions.toSorted((left, right) =>
      (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""),
    );
    setSessions(sorted);
    setSelectedSessionId(sorted[0]?.sessionId ?? null);
  }, [activeProvider?.instanceId, environmentId, listProviderSessions]);

  useEffect(() => {
    if (!open) return;
    setModel(initialModel(activeProvider));
    void refreshSessions();
  }, [activeProvider, open, refreshSessions]);

  useEffect(() => {
    if (!selectedSession) return;
    setProjectId((current) =>
      resolveNativeSessionProject(
        selectedSession.cwd,
        environmentProjects,
        environmentId,
        current ?? undefined,
      ),
    );
  }, [environmentId, environmentProjects, selectedSession]);

  const importSession = useCallback(async () => {
    if (!activeProvider || !selectedSession || !projectId || !model || isImporting) return;
    setIsImporting(true);
    setError(null);
    const threadId = newThreadId();
    const title = nativeSessionTitle(selectedSession);
    const modelSelection = createModelSelection(activeProvider.instanceId, model, [
      { id: "reasoningEffort", value: thinking },
    ]);
    const createResult = await createThread({
      environmentId,
      input: {
        threadId,
        projectId,
        title,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      },
    });
    if (createResult._tag === "Failure") {
      setIsImporting(false);
      if (!isAtomCommandInterrupted(createResult)) {
        setError(failureMessage(squashAtomCommandFailure(createResult)));
      }
      return;
    }

    const bindResult = await bindProviderSession({
      environmentId,
      input: {
        threadId,
        providerInstanceId: activeProvider.instanceId,
        sessionId: selectedSession.sessionId,
        cwd: selectedSession.cwd,
        modelSelection,
        runtimeMode: "full-access",
      },
    });
    if (bindResult._tag === "Failure") {
      await deleteThread({ environmentId, input: { threadId } });
      setIsImporting(false);
      if (!isAtomCommandInterrupted(bindResult)) {
        setError(failureMessage(squashAtomCommandFailure(bindResult)));
      }
      return;
    }

    toastManager.add(
      stackedThreadToast({
        type: "success",
        title: "Provider session imported",
        description: `${title} is ready in T3 Code with ${model} · ${thinking}.`,
      }),
    );
    onOpenChange(false);
    await navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId },
    });
    setIsImporting(false);
  }, [
    activeProvider,
    bindProviderSession,
    createThread,
    deleteThread,
    environmentId,
    isImporting,
    model,
    navigate,
    onOpenChange,
    projectId,
    selectedSession,
    thinking,
  ]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import an Ocean or Pi session</DialogTitle>
          <DialogDescription>
            Resume a native conversation in T3 Code. Model and thinking are stored on the imported
            thread and applied before its next turn.
          </DialogDescription>
        </DialogHeader>

        <DialogPanel className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">Provider</span>
              <Select
                value={activeProvider?.instanceId ?? null}
                onValueChange={(value) => {
                  if (typeof value !== "string") return;
                  setProviderInstanceId(value as ProviderInstanceId);
                  setSessions([]);
                  setSelectedSessionId(null);
                }}
              >
                <SelectTrigger disabled={importableProviders.length === 0}>
                  <SelectValue>
                    {activeProvider
                      ? (activeProvider.displayName ??
                        PROVIDER_DISPLAY_NAMES[activeProvider.driver] ??
                        activeProvider.instanceId)
                      : "No Ocean/Pi provider"}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {importableProviders.map((provider) => (
                    <SelectItem key={provider.instanceId} value={provider.instanceId}>
                      {provider.displayName ??
                        PROVIDER_DISPLAY_NAMES[provider.driver] ??
                        provider.instanceId}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </label>

            <label className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">T3 project</span>
              <Select
                value={projectId}
                onValueChange={(value) => {
                  if (typeof value === "string") setProjectId(value as ProjectId);
                }}
              >
                <SelectTrigger disabled={environmentProjects.length === 0}>
                  <SelectValue>
                    {environmentProjects.find((project) => project.id === projectId)?.title ??
                      "No project"}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {environmentProjects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.title}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </label>

            <label className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">Model</span>
              <Select
                value={model}
                onValueChange={(value) => {
                  if (typeof value === "string") setModel(value);
                }}
              >
                <SelectTrigger disabled={!activeProvider || activeProvider.models.length === 0}>
                  <SelectValue>
                    {activeProvider?.models.find((entry) => entry.slug === model)?.name ??
                      model ??
                      "No model"}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {activeProvider?.models.map((entry) => (
                    <SelectItem key={entry.slug} value={entry.slug}>
                      {entry.name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </label>

            <label className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">Thinking</span>
              <Select
                value={thinking}
                onValueChange={(value) => {
                  if (
                    typeof value === "string" &&
                    THINKING_LEVELS.some(([level]) => level === value)
                  ) {
                    setThinking(value as (typeof THINKING_LEVELS)[number][0]);
                  }
                }}
              >
                <SelectTrigger>
                  <SelectValue>
                    {THINKING_LEVELS.find(([level]) => level === thinking)?.[1] ?? thinking}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {THINKING_LEVELS.map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </label>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-medium text-foreground">Native sessions</h3>
                <p className="text-xs text-muted-foreground">
                  {sessions.length} conversation{sessions.length === 1 ? "" : "s"} found
                </p>
              </div>
              <Button
                size="icon-sm"
                variant="ghost"
                disabled={isLoading || !activeProvider}
                onClick={() => void refreshSessions()}
                aria-label="Refresh native sessions"
              >
                {isLoading ? (
                  <LoaderIcon className="size-4 animate-spin" />
                ) : (
                  <RefreshCwIcon className="size-4" />
                )}
              </Button>
            </div>

            <div className="max-h-64 space-y-1.5 overflow-y-auto rounded-xl border bg-muted/20 p-1.5">
              {isLoading ? (
                <div className="grid min-h-24 place-items-center text-sm text-muted-foreground">
                  Loading sessions…
                </div>
              ) : sessions.length === 0 ? (
                <div className="grid min-h-24 place-items-center px-4 text-center text-sm text-muted-foreground">
                  No native session was returned by this provider.
                </div>
              ) : (
                sessions.map((session) => {
                  const selected = session.sessionId === selectedSession?.sessionId;
                  return (
                    <button
                      key={session.sessionId}
                      type="button"
                      className={cn(
                        "grid w-full gap-1 rounded-lg px-3 py-2.5 text-left outline-none ring-1 transition",
                        selected
                          ? "bg-primary/10 text-foreground ring-primary/50"
                          : "bg-background text-muted-foreground ring-border hover:bg-accent hover:text-foreground",
                      )}
                      onClick={() => setSelectedSessionId(session.sessionId)}
                    >
                      <span className="truncate text-sm font-medium text-foreground">
                        {nativeSessionTitle(session)}
                      </span>
                      <span className="truncate font-mono text-[11px]">{session.cwd}</span>
                      <span className="truncate font-mono text-[10px] opacity-70">
                        {session.sessionId}
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </div>

          {environmentProjects.length === 0 ? (
            <p className="text-sm text-destructive">
              Create at least one T3 project in this environment before importing a session.
            </p>
          ) : null}
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </DialogPanel>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isImporting}>
            Cancel
          </Button>
          <Button
            onClick={() => void importSession()}
            disabled={
              isImporting ||
              !activeProvider ||
              !selectedSession ||
              !projectId ||
              !model ||
              isLoading
            }
          >
            {isImporting ? <LoaderIcon className="size-4 animate-spin" /> : null}
            Import and resume
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
