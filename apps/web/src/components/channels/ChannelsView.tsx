import {
  AgentId,
  ChannelId,
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  type RuntimeMode,
  ThreadId,
  type OrchestrationAgent,
  type OrchestrationChannel,
  type OrchestrationChannelMessage,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Link, useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import {
  HashIcon,
  PencilIcon,
  PlusIcon,
  ReplyIcon,
  SendIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useProjects } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { cn, randomUUID } from "../../lib/utils";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { primaryServerProvidersAtom } from "../../state/server";
import { useEnvironmentThread } from "../../state/threads";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SidebarInset } from "../ui/sidebar";

function newId<T>(make: (value: string) => T): T {
  return make(randomUUID());
}

function agentLabel(
  agentId: OrchestrationChannel["agentId"],
  agents: ReadonlyArray<{ readonly id: OrchestrationChannel["agentId"]; readonly name: string }>,
) {
  return agents.find((agent) => agent.id === agentId)?.name ?? "Unknown agent";
}

function ChannelMessageRow({
  message,
  onReply,
}: {
  message: OrchestrationChannelMessage;
  onReply: (message: OrchestrationChannelMessage) => void;
}) {
  const isUser = message.role === "user";
  return (
    <article
      className={cn("group flex", isUser ? "justify-end" : "justify-start")}
      data-channel-message-id={message.id}
    >
      <div
        className={cn(
          "max-w-[78%] rounded-2xl border px-4 py-3 shadow-xs",
          isUser
            ? "border-primary/20 bg-primary text-primary-foreground"
            : "border-border/70 bg-card text-card-foreground",
          message.parentMessageId !== null && "border-l-4",
        )}
      >
        <div className="mb-1 flex items-center gap-2 text-[11px] font-medium opacity-70">
          <span>{isUser ? "You" : message.role === "assistant" ? "Agent" : "System"}</span>
          {message.parentMessageId !== null ? <span>reply</span> : null}
        </div>
        <p className="whitespace-pre-wrap text-sm leading-6">{message.text}</p>
        <button
          type="button"
          className="mt-2 inline-flex items-center gap-1 text-xs opacity-0 transition-opacity group-hover:opacity-70 focus:opacity-100"
          onClick={() => onReply(message)}
        >
          <ReplyIcon className="size-3" /> Reply
        </button>
      </div>
    </article>
  );
}

export function ChannelsView({ selectedChannelId }: { selectedChannelId: ChannelId | null }) {
  const navigate = useNavigate();
  const environmentId = usePrimaryEnvironmentId();
  const projects = useProjects().filter(
    (project) => environmentId !== null && project.environmentId === environmentId,
  );
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const providerEntries = useMemo(
    () =>
      deriveProviderInstanceEntries(serverProviders).filter(
        (entry) => entry.enabled && entry.installed && entry.isAvailable,
      ),
    [serverProviders],
  );
  const channelsQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : orchestrationEnvironment.channelsSnapshot({ environmentId, input: {} }),
  );
  const channelQuery = useEnvironmentQuery(
    environmentId === null || selectedChannelId === null
      ? null
      : orchestrationEnvironment.channelsSnapshot({
          environmentId,
          input: { channelId: selectedChannelId },
        }),
  );
  const dispatch = useAtomCommand(orchestrationEnvironment.dispatchCommand);
  const [isCreating, setIsCreating] = useState(false);
  const [isCreatingAgent, setIsCreatingAgent] = useState(false);
  const [editingAgentId, setEditingAgentId] = useState<AgentId | null>(null);
  const [agentDeleteArmedId, setAgentDeleteArmedId] = useState<AgentId | null>(null);
  const [channelName, setChannelName] = useState("");
  const [projectId, setProjectId] = useState<ProjectId | "">("");
  const [agentId, setAgentId] = useState<AgentId | "">("");
  const [agentName, setAgentName] = useState("");
  const [agentRole, setAgentRole] = useState("");
  const [agentInstructions, setAgentInstructions] = useState("");
  const [agentRuntimeMode, setAgentRuntimeMode] = useState<RuntimeMode>("approval-required");
  const [agentProviderId, setAgentProviderId] = useState<ProviderInstanceId | "">("");
  const [agentModel, setAgentModel] = useState("");
  const [draft, setDraft] = useState("");
  const [replyingTo, setReplyingTo] = useState<OrchestrationChannelMessage | null>(null);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const conversationEndRef = useRef<HTMLDivElement>(null);

  const snapshot = channelQuery.data ?? channelsQuery.data;
  const refreshSnapshots = useCallback(() => {
    channelsQuery.refresh();
    channelQuery.refresh();
  }, [channelQuery.refresh, channelsQuery.refresh]);
  const agents = snapshot?.agents ?? [];
  const channels = snapshot?.channels ?? [];
  const selectedChannel = channels.find((channel) => channel.id === selectedChannelId) ?? null;
  const channelThreadState = useEnvironmentThread(environmentId, selectedChannel?.threadId ?? null);
  const channelThread = Option.getOrNull(channelThreadState.data);
  const messages = useMemo(() => {
    const threadMessagesById = new Map(
      (channelThread?.messages ?? []).map((message) => [message.id, message] as const),
    );
    return (snapshot?.messages ?? [])
      .filter((message) => message.channelId === selectedChannel?.id)
      .map((message) => {
        const threadMessage = threadMessagesById.get(message.threadMessageId);
        return threadMessage
          ? { ...message, role: threadMessage.role, text: threadMessage.text }
          : message;
      })
      .toSorted((left, right) => left.sequence - right.sequence);
  }, [channelThread?.messages, selectedChannel?.id, snapshot?.messages]);

  useEffect(() => {
    if (!snapshot || selectedChannelId !== null || snapshot.channels.length === 0) return;
    void navigate({
      to: "/channels/$channelId",
      params: { channelId: snapshot.channels[0]!.id },
      replace: true,
    });
  }, [navigate, selectedChannelId, snapshot]);

  const channelThreadMessageCount = channelThread?.messages.length ?? 0;
  useEffect(() => {
    if (selectedChannelId === null || channelThreadMessageCount === 0) return;
    channelQuery.refresh();
  }, [channelQuery.refresh, channelThreadMessageCount, selectedChannelId]);

  useEffect(() => {
    setDeleteArmed(false);
    setReplyingTo(null);
  }, [selectedChannel?.id]);

  const latestMessage = messages.at(-1);
  useEffect(() => {
    conversationEndRef.current?.scrollIntoView({ block: "end" });
  }, [latestMessage?.id, latestMessage?.text]);

  useEffect(() => {
    if (agentProviderId !== "" || providerEntries.length === 0) return;
    const provider = providerEntries[0]!;
    setAgentProviderId(provider.instanceId);
    setAgentModel(provider.models[0]?.slug ?? "");
  }, [agentProviderId, providerEntries]);

  const resetAgentForm = () => {
    setAgentName("");
    setAgentRole("");
    setAgentInstructions("");
    setEditingAgentId(null);
    setIsCreatingAgent(false);
  };

  const editAgent = (agent: OrchestrationAgent) => {
    setEditingAgentId(agent.id);
    setAgentName(agent.name);
    setAgentRole(agent.role);
    setAgentInstructions(agent.instructions);
    setAgentRuntimeMode(agent.runtimeMode);
    setAgentProviderId(agent.modelSelection.instanceId);
    setAgentModel(agent.modelSelection.model);
    setAgentDeleteArmedId(null);
    setIsCreatingAgent(true);
  };

  const createAgent = async () => {
    if (
      environmentId === null ||
      agentName.trim() === "" ||
      agentRole.trim() === "" ||
      agentProviderId === "" ||
      agentModel === ""
    ) {
      return;
    }
    setIsSubmitting(true);
    const nextAgentId = editingAgentId ?? newId(AgentId.make);
    const result = await dispatch({
      environmentId,
      input:
        editingAgentId === null
          ? {
              type: "agent.create",
              commandId: newId(CommandId.make),
              agentId: nextAgentId,
              name: agentName.trim(),
              role: agentRole.trim(),
              instructions: agentInstructions.trim(),
              modelSelection: { instanceId: agentProviderId, model: agentModel },
              runtimeMode: agentRuntimeMode,
              createdAt: new Date().toISOString(),
            }
          : {
              type: "agent.update",
              commandId: newId(CommandId.make),
              agentId: editingAgentId,
              name: agentName.trim(),
              role: agentRole.trim(),
              instructions: agentInstructions.trim(),
              modelSelection: { instanceId: agentProviderId, model: agentModel },
              runtimeMode: agentRuntimeMode,
            },
    });
    setIsSubmitting(false);
    if (result._tag !== "Success") return;
    setAgentId(nextAgentId);
    resetAgentForm();
    refreshSnapshots();
  };

  const deleteAgent = async (targetAgentId: AgentId) => {
    if (environmentId === null) return;
    if (agentDeleteArmedId !== targetAgentId) {
      setAgentDeleteArmedId(targetAgentId);
      return;
    }
    const result = await dispatch({
      environmentId,
      input: {
        type: "agent.delete",
        commandId: newId(CommandId.make),
        agentId: targetAgentId,
      },
    });
    if (result._tag !== "Success") return;
    if (agentId === targetAgentId) setAgentId("");
    if (editingAgentId === targetAgentId) resetAgentForm();
    setAgentDeleteArmedId(null);
    refreshSnapshots();
  };

  const createChannel = async () => {
    if (environmentId === null || channelName.trim() === "" || projectId === "" || agentId === "") {
      return;
    }
    setIsSubmitting(true);
    const channelId = newId(ChannelId.make);
    const result = await dispatch({
      environmentId,
      input: {
        type: "channel.create",
        commandId: newId(CommandId.make),
        channelId,
        projectId,
        threadId: newId(ThreadId.make),
        agentId,
        name: channelName.trim(),
        createdAt: new Date().toISOString(),
      },
    });
    setIsSubmitting(false);
    if (result._tag !== "Success") return;
    setChannelName("");
    setIsCreating(false);
    refreshSnapshots();
    void navigate({ to: "/channels/$channelId", params: { channelId } });
  };

  const sendMessage = async () => {
    if (environmentId === null || selectedChannel === null || draft.trim() === "") return;
    setIsSubmitting(true);
    const result = await dispatch({
      environmentId,
      input: {
        type: "channel.message.send",
        commandId: newId(CommandId.make),
        channelId: selectedChannel.id,
        message: {
          messageId: newId(MessageId.make),
          role: "user",
          text: draft.trim(),
          attachments: [],
          ...(replyingTo ? { parentMessageId: replyingTo.id } : {}),
        },
        createdAt: new Date().toISOString(),
      },
    });
    setIsSubmitting(false);
    if (result._tag !== "Success") return;
    setDraft("");
    setReplyingTo(null);
    refreshSnapshots();
  };

  const renameChannel = async () => {
    if (
      environmentId === null ||
      selectedChannel === null ||
      editingName === null ||
      editingName.trim() === ""
    ) {
      return;
    }
    const result = await dispatch({
      environmentId,
      input: {
        type: "channel.update",
        commandId: newId(CommandId.make),
        channelId: selectedChannel.id,
        name: editingName.trim(),
      },
    });
    if (result._tag === "Success") {
      setEditingName(null);
      refreshSnapshots();
    }
  };

  const deleteChannel = async () => {
    if (environmentId === null || selectedChannel === null) return;
    const result = await dispatch({
      environmentId,
      input: {
        type: "channel.delete",
        commandId: newId(CommandId.make),
        channelId: selectedChannel.id,
      },
    });
    if (result._tag === "Success") {
      refreshSnapshots();
      void navigate({ to: "/channels" });
    }
  };

  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden bg-background md:h-dvh">
      <div className="flex h-full min-h-0 pt-[var(--workspace-topbar-height)]">
        <aside className="flex w-64 shrink-0 flex-col border-r border-border/70 bg-muted/20">
          <div className="flex h-12 items-center justify-between border-b border-border/70 px-4">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <HashIcon className="size-4" /> Channels
            </div>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Create channel"
              onClick={() => setIsCreating((value) => !value)}
            >
              {isCreating ? <XIcon /> : <PlusIcon />}
            </Button>
          </div>
          {isCreating ? (
            <div className="max-h-[70vh] space-y-2 overflow-y-auto border-b border-border/70 p-3">
              <Input
                aria-label="Channel name"
                placeholder="channel-name"
                value={channelName}
                onChange={(event) => setChannelName(event.target.value)}
              />
              <select
                aria-label="Project"
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                value={projectId}
                onChange={(event) =>
                  setProjectId(event.target.value === "" ? "" : ProjectId.make(event.target.value))
                }
              >
                <option value="">Select project</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.title}
                  </option>
                ))}
              </select>
              <select
                aria-label="Agent"
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                value={agentId}
                onChange={(event) =>
                  setAgentId(event.target.value === "" ? "" : AgentId.make(event.target.value))
                }
              >
                <option value="">Select agent</option>
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name} · {agent.role}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="text-left text-xs font-medium text-primary hover:underline"
                onClick={() => {
                  if (isCreatingAgent) {
                    resetAgentForm();
                    return;
                  }
                  setEditingAgentId(null);
                  setAgentName("");
                  setAgentRole("");
                  setAgentInstructions("");
                  setAgentDeleteArmedId(null);
                  setIsCreatingAgent(true);
                }}
              >
                {isCreatingAgent ? "Hide agent form" : "+ Configure a new agent"}
              </button>
              {agents.length > 0 ? (
                <div className="space-y-1 rounded-lg border border-border/70 bg-background p-2">
                  <p className="px-1 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    Reusable agents
                  </p>
                  {agents.map((agent) => {
                    const isAssigned = channels.some((channel) => channel.agentId === agent.id);
                    const deleteArmed = agentDeleteArmedId === agent.id;
                    return (
                      <div key={agent.id} className="flex items-center gap-1 rounded-md px-1 py-1">
                        <button
                          type="button"
                          className="min-w-0 flex-1 truncate text-left text-xs hover:text-primary"
                          onClick={() => editAgent(agent)}
                        >
                          {agent.name} · {agent.role}
                        </button>
                        <button
                          type="button"
                          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                          aria-label={`Edit agent ${agent.name}`}
                          onClick={() => editAgent(agent)}
                        >
                          <PencilIcon className="size-3" />
                        </button>
                        <button
                          type="button"
                          className={cn(
                            "rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive",
                            deleteArmed && "bg-destructive/10 text-destructive",
                          )}
                          aria-label={
                            deleteArmed
                              ? `Confirm delete agent ${agent.name}`
                              : `Delete agent ${agent.name}`
                          }
                          title={isAssigned ? "Delete this agent's channels first" : undefined}
                          disabled={isAssigned}
                          onClick={() => void deleteAgent(agent.id)}
                        >
                          <Trash2Icon className="size-3" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              ) : null}
              {isCreatingAgent ? (
                <div className="space-y-2 rounded-lg border border-border/70 bg-background p-2">
                  <Input
                    aria-label="Agent name"
                    placeholder="Agent name"
                    value={agentName}
                    onChange={(event) => setAgentName(event.target.value)}
                  />
                  <Input
                    aria-label="Agent role"
                    placeholder="Role (for example, Reviewer)"
                    value={agentRole}
                    onChange={(event) => setAgentRole(event.target.value)}
                  />
                  <textarea
                    aria-label="Agent instructions"
                    className="min-h-16 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm outline-none"
                    placeholder="Persistent instructions"
                    value={agentInstructions}
                    onChange={(event) => setAgentInstructions(event.target.value)}
                  />
                  <select
                    aria-label="Agent provider"
                    className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                    value={agentProviderId}
                    onChange={(event) => {
                      const nextId = ProviderInstanceId.make(event.target.value);
                      const provider = providerEntries.find((entry) => entry.instanceId === nextId);
                      setAgentProviderId(nextId);
                      setAgentModel(provider?.models[0]?.slug ?? "");
                    }}
                  >
                    {providerEntries.map((provider) => (
                      <option key={provider.instanceId} value={provider.instanceId}>
                        {provider.displayName}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label="Agent model"
                    className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                    value={agentModel}
                    onChange={(event) => setAgentModel(event.target.value)}
                  >
                    {(
                      providerEntries.find((provider) => provider.instanceId === agentProviderId)
                        ?.models ?? []
                    ).map((model) => (
                      <option key={model.slug} value={model.slug}>
                        {model.name}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label="Agent runtime mode"
                    className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                    value={agentRuntimeMode}
                    onChange={(event) => setAgentRuntimeMode(event.target.value as RuntimeMode)}
                  >
                    <option value="approval-required">Approval required</option>
                    <option value="auto-accept-edits">Auto-accept edits</option>
                    <option value="auto">Auto</option>
                    <option value="full-access">Full access</option>
                  </select>
                  <Button
                    className="w-full"
                    size="sm"
                    variant="secondary"
                    disabled={isSubmitting}
                    onClick={createAgent}
                  >
                    {editingAgentId === null ? "Save agent" : "Update agent"}
                  </Button>
                </div>
              ) : null}
              <Button className="w-full" size="sm" disabled={isSubmitting} onClick={createChannel}>
                Create channel
              </Button>
            </div>
          ) : null}
          <nav className="min-h-0 flex-1 overflow-y-auto p-2" aria-label="Channels">
            {channels.map((channel) => (
              <Link
                key={channel.id}
                to="/channels/$channelId"
                params={{ channelId: channel.id }}
                className={cn(
                  "mb-1 flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground",
                  channel.id === selectedChannel?.id && "bg-accent font-medium text-foreground",
                )}
              >
                <HashIcon className="size-3.5" />
                <span className="min-w-0 flex-1 truncate">{channel.name}</span>
              </Link>
            ))}
            {!channelsQuery.isPending && channels.length === 0 ? (
              <p className="px-3 py-8 text-center text-xs text-muted-foreground">
                No channels yet.
              </p>
            ) : null}
          </nav>
        </aside>

        {selectedChannel ? (
          <main className="flex min-w-0 flex-1 flex-col">
            <header className="flex h-12 shrink-0 items-center justify-between border-b border-border/70 px-5">
              <div className="min-w-0">
                {editingName === null ? (
                  <h1 className="truncate text-sm font-semibold"># {selectedChannel.name}</h1>
                ) : (
                  <Input
                    className="h-8 w-64"
                    value={editingName}
                    onChange={(event) => setEditingName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void renameChannel();
                      if (event.key === "Escape") setEditingName(null);
                    }}
                    autoFocus
                  />
                )}
                <p className="text-xs text-muted-foreground">
                  {agentLabel(selectedChannel.agentId, agents)}
                </p>
              </div>
              <div className="flex gap-1">
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Rename channel"
                  onClick={() => setEditingName(selectedChannel.name)}
                >
                  <PencilIcon />
                </Button>
                <Button
                  size={deleteArmed ? "sm" : "icon-sm"}
                  variant={deleteArmed ? "destructive" : "ghost"}
                  aria-label={deleteArmed ? "Confirm delete channel" : "Delete channel"}
                  onClick={() => (deleteArmed ? void deleteChannel() : setDeleteArmed(true))}
                >
                  <Trash2Icon /> {deleteArmed ? "Confirm delete" : null}
                </Button>
              </div>
            </header>
            <section
              className="min-h-0 flex-1 overflow-y-auto px-6 py-6"
              aria-label="Channel conversation"
            >
              <div className="mx-auto flex max-w-3xl flex-col gap-4">
                {messages.map((message) => (
                  <ChannelMessageRow key={message.id} message={message} onReply={setReplyingTo} />
                ))}
                {messages.length === 0 ? (
                  <div className="py-24 text-center">
                    <HashIcon className="mx-auto mb-3 size-8 text-muted-foreground/50" />
                    <h2 className="font-medium">Start the channel</h2>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Message the assigned agent to begin work.
                    </p>
                  </div>
                ) : null}
                <div ref={conversationEndRef} />
              </div>
            </section>
            <footer className="shrink-0 border-t border-border/70 p-4">
              <div className="mx-auto max-w-3xl rounded-xl border border-border bg-card shadow-xs">
                {replyingTo ? (
                  <div className="flex items-center justify-between border-b border-border/70 px-3 py-2 text-xs text-muted-foreground">
                    <span className="truncate">Replying to {replyingTo.text}</span>
                    <button
                      type="button"
                      aria-label="Cancel reply"
                      onClick={() => setReplyingTo(null)}
                    >
                      <XIcon className="size-3.5" />
                    </button>
                  </div>
                ) : null}
                <textarea
                  className="min-h-20 w-full resize-none bg-transparent px-4 py-3 text-sm outline-none"
                  aria-label="Message channel"
                  placeholder={`Message #${selectedChannel.name}`}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void sendMessage();
                    }
                  }}
                />
                <div className="flex justify-end px-2 pb-2">
                  <Button
                    size="sm"
                    disabled={isSubmitting || draft.trim() === ""}
                    onClick={sendMessage}
                  >
                    <SendIcon /> Send
                  </Button>
                </div>
              </div>
            </footer>
          </main>
        ) : (
          <main className="grid min-w-0 flex-1 place-items-center text-center">
            <div>
              <HashIcon className="mx-auto mb-3 size-10 text-muted-foreground/40" />
              <h1 className="text-lg font-semibold">Channels</h1>
              <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                Create a project channel and assign a configured agent to work in it.
              </p>
            </div>
          </main>
        )}
      </div>
    </SidebarInset>
  );
}
