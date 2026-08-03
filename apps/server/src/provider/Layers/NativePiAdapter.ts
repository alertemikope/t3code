import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  type InlineExtension,
  ModelRuntime,
  ProjectTrustStore,
  resolveCliModel,
  type SessionInfo,
  SessionManager,
  SettingsManager,
  hasTrustRequiringProjectResources,
} from "@earendil-works/pi-coding-agent";
import {
  ApprovalRequestId,
  EventId,
  type ProviderApprovalDecision,
  type ProviderInstanceId,
  ProviderDriverKind,
  type ModelSelection,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  RuntimeRequestId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { getProviderOptionStringSelectionValue } from "@t3tools/shared/model";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import {
  type PiEventIdentity,
  makePiContentDeltaEvent,
  makePiItemEvent,
  makePiRequestOpenedEvent,
  makePiRequestResolvedEvent,
  makePiToolEvent,
} from "../pi/PiRuntimeEvents.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";

const PROVIDER = ProviderDriverKind.make("piAgent");
const PI_RESUME_VERSION = 1 as const;
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
const EDIT_TOOLS = new Set(["edit", "write", "apply_patch"]);
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

type PiModel = NonNullable<AgentSession["model"]>;
type PiThinkingLevel = AgentSession["thinkingLevel"];
type PiPromptOptions = Parameters<AgentSession["prompt"]>[1];
type PiPromptImage = NonNullable<NonNullable<PiPromptOptions>["images"]>[number];

export interface NativePiSession {
  readonly sessionId: string;
  readonly sessionFile: string | undefined;
  readonly model: AgentSession["model"];
  readonly thinkingLevel: PiThinkingLevel;
  readonly isStreaming: boolean;
  readonly messages: AgentSession["messages"];
  readonly prompt: (text: string, options?: PiPromptOptions) => Promise<void>;
  readonly abort: () => Promise<void>;
  readonly dispose: () => void;
  readonly shutdown?: () => Promise<void>;
  readonly extensionToolNames?: ReadonlySet<string>;
  readonly subscribe: AgentSession["subscribe"];
  readonly setModel: (model: PiModel) => Promise<void>;
  readonly setThinkingLevel: (level: PiThinkingLevel) => void;
  readonly navigateTree: AgentSession["navigateTree"];
  readonly getLeafId: () => string | null;
  readonly resetLeaf: () => void;
}

export interface NativePiToolCall {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: Readonly<Record<string, unknown>>;
}

export interface NativePiSessionFactoryInput {
  readonly cwd: string;
  readonly resumePath: string | undefined;
  readonly model: PiModel | undefined;
  readonly thinkingLevel: PiThinkingLevel | undefined;
  readonly authorizeTool: (
    toolCall: NativePiToolCall,
  ) => Promise<{ readonly block?: boolean; readonly reason?: string } | undefined>;
}

export interface NativePiSdk {
  readonly createSession: (input: NativePiSessionFactoryInput) => Promise<NativePiSession>;
  readonly listSessions: (cwd?: string) => Promise<ReadonlyArray<SessionInfo>>;
  readonly resolveModel: (
    slug: string,
  ) =>
    | { readonly model: PiModel; readonly error?: undefined }
    | { readonly model?: undefined; readonly error: string };
}

export interface NativePiAdapterOptions {
  readonly instanceId: ProviderInstanceId;
  readonly enabled: boolean;
  readonly sdk?: NativePiSdk;
  readonly modelRuntime?: ModelRuntime;
}

interface PendingApproval {
  readonly toolName: string;
  readonly resolve: (decision: ProviderApprovalDecision) => void;
}

interface ContentItemState {
  readonly id: string;
  readonly itemType: "assistant_message" | "reasoning";
}

interface NativePiSessionContext {
  readonly threadId: ThreadId;
  readonly session: NativePiSession;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly approvedTools: Set<string>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown>; entryIds: Array<string> }>;
  readonly contentItems: Map<number, ContentItemState>;
  readonly toolArgs: Map<string, unknown>;
  readonly initialEntryId: string | undefined;
  readonly reservedSessionPath: string | undefined;
  runtimeMode: ProviderSession["runtimeMode"];
  providerSession: ProviderSession;
  unsubscribe: (() => void) | undefined;
  activeTurnId: TurnId | undefined;
  activeTurnStartedAt: number | undefined;
  compactionItemId: string | undefined;
  abortReason: string | undefined;
  eventChain: Promise<void>;
  stopped: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseResumeCursor(
  value: unknown,
): { readonly sessionId: string; readonly path?: string } | null {
  if (!isRecord(value) || value.schemaVersion !== PI_RESUME_VERSION) return null;
  if (typeof value.sessionId !== "string" || value.sessionId.trim().length === 0) return null;
  const path = typeof value.path === "string" && value.path.trim() ? value.path.trim() : undefined;
  return { sessionId: value.sessionId.trim(), ...(path ? { path } : {}) };
}

function piThinkingLevel(value: string | undefined): PiThinkingLevel | undefined {
  return value && THINKING_LEVELS.has(value) ? (value as PiThinkingLevel) : undefined;
}

function isPiMediaType(value: string): boolean {
  return (
    value === "image/jpeg" ||
    value === "image/png" ||
    value === "image/gif" ||
    value === "image/webp"
  );
}

function messageText(message: unknown): string {
  if (!isRecord(message)) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) => {
      if (!isRecord(block)) return [];
      if (block.type === "text" && typeof block.text === "string") return [block.text];
      if (block.type === "thinking" && typeof block.thinking === "string") return [block.thinking];
      return [];
    })
    .join("\n");
}

function messageRole(message: unknown): string | undefined {
  return isRecord(message) && typeof message.role === "string" ? message.role : undefined;
}

function assistantOutcome(messages: ReadonlyArray<unknown>): {
  readonly state: "completed" | "failed" | "cancelled";
  readonly stopReason?: string;
  readonly usage?: unknown;
  readonly errorMessage?: string;
} {
  const assistant = messages.findLast((message) => messageRole(message) === "assistant");
  if (!isRecord(assistant)) return { state: "completed" };
  const stopReason = typeof assistant.stopReason === "string" ? assistant.stopReason : undefined;
  const errorMessage =
    typeof assistant.errorMessage === "string" ? assistant.errorMessage : undefined;
  const state =
    stopReason === "error" ? "failed" : stopReason === "aborted" ? "cancelled" : "completed";
  return {
    state,
    ...(stopReason ? { stopReason } : {}),
    ...(assistant.usage === undefined ? {} : { usage: assistant.usage }),
    ...(errorMessage ? { errorMessage } : {}),
  };
}

function makeDefaultSdk(modelRuntime: ModelRuntime): NativePiSdk {
  const agentDir = getAgentDir();
  return {
    createSession: async (input) => {
      const projectTrusted =
        !hasTrustRequiringProjectResources(input.cwd) ||
        new ProjectTrustStore(agentDir).get(input.cwd) === true;
      const settingsManager = SettingsManager.create(input.cwd, agentDir, { projectTrusted });
      const approvalExtension: InlineExtension = {
        name: "t3-native-approvals",
        factory: (pi) => {
          pi.on("tool_call", async (event) =>
            input.authorizeTool({
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              args: Object.fromEntries(Object.entries(event.input)),
            }),
          );
        },
      };
      const resourceLoader = new DefaultResourceLoader({
        cwd: input.cwd,
        agentDir,
        settingsManager,
        extensionFactories: [approvalExtension],
      });
      await resourceLoader.reload({ resolveProjectTrust: async () => projectTrusted });
      const sessionManager = input.resumePath
        ? SessionManager.open(input.resumePath)
        : SessionManager.create(input.cwd);
      const { session } = await createAgentSession({
        cwd: input.cwd,
        agentDir,
        modelRuntime,
        settingsManager,
        sessionManager,
        resourceLoader,
        ...(input.model ? { model: input.model } : {}),
        ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
      });
      const extensionToolNames = new Set(
        resourceLoader
          .getExtensions()
          .extensions.flatMap((extension) => Array.from(extension.tools.keys())),
      );
      return Object.assign(session, {
        extensionToolNames,
        shutdown: async () => {
          await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        },
        getLeafId: () => session.sessionManager.getLeafId(),
        resetLeaf: () => {
          session.sessionManager.resetLeaf();
          session.agent.state.messages = session.sessionManager.buildSessionContext().messages;
        },
      });
    },
    listSessions: (cwd) => (cwd ? SessionManager.list(cwd) : SessionManager.listAll()),
    resolveModel: (slug) => {
      const resolved = resolveCliModel({ cliModel: slug, modelRuntime });
      return resolved.model
        ? { model: resolved.model }
        : { error: resolved.error ?? `Pi model '${slug}' is unavailable.` };
    },
  };
}

export function makeNativePiAdapter(options: NativePiAdapterOptions) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverConfig = yield* ServerConfig;
    const crypto = yield* Crypto.Crypto;
    const runtimeContext = yield* Effect.context<never>();
    const runPromise = Effect.runPromiseWith(runtimeContext);
    const sdk = options.sdk
      ? options.sdk
      : makeDefaultSdk(
          options.modelRuntime ??
            (yield* Effect.tryPromise({
              try: () => ModelRuntime.create(),
              catch: (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "ModelRuntime.create",
                  detail: "Failed to initialize the embedded Pi model runtime.",
                  cause,
                }),
            })),
        );
    const runtimeEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, NativePiSessionContext>();
    const openPiSessionFiles = new Map<string, string>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());

    const getThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing = current.get(threadId);
        if (existing) return Effect.succeed([existing, current] as const);
        return Semaphore.make(1).pipe(
          Effect.map((semaphore) => {
            const next = new Map(current);
            next.set(threadId, semaphore);
            return [semaphore, next] as const;
          }),
        );
      });

    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

    const requestError = (method: string, cause: unknown) =>
      new ProviderAdapterRequestError({
        provider: PROVIDER,
        method,
        detail: cause instanceof Error ? cause.message : String(cause),
        cause,
      });
    const nextUuid = crypto.randomUUIDv4.pipe(
      Effect.mapError((cause) => requestError("crypto.randomUUIDv4", cause)),
    );
    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const makeStamp = () =>
      Effect.all({ eventId: Effect.map(nextUuid, EventId.make), createdAt: nowIso });
    const stampPromise = () => runPromise(makeStamp());
    const uuidPromise = () => runPromise(nextUuid);
    const nowIsoPromise = () => runPromise(nowIso);
    const nowMillisPromise = () => runPromise(Clock.currentTimeMillis);
    const offer = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEvents, event).pipe(Effect.asVoid);
    const offerPromise = (event: ProviderRuntimeEvent) => runPromise(offer(event));
    const identity = (context: NativePiSessionContext): PiEventIdentity => ({
      provider: PROVIDER,
      providerInstanceId: options.instanceId,
      threadId: context.threadId,
      turnId: context.activeTurnId,
    });

    const shouldAutoApprove = (context: NativePiSessionContext, toolName: string) => {
      if (context.approvedTools.has(toolName) || context.runtimeMode === "full-access") return true;
      if (context.session.extensionToolNames?.has(toolName)) return false;
      if (READ_ONLY_TOOLS.has(toolName)) return true;
      return context.runtimeMode === "auto-accept-edits" && EDIT_TOOLS.has(toolName);
    };

    const authorizeTool = async (
      context: NativePiSessionContext,
      toolCall: NativePiToolCall,
    ): Promise<{ readonly block?: boolean; readonly reason?: string } | undefined> => {
      if (context.stopped) return { block: true, reason: "The T3 thread is closed." };
      if (shouldAutoApprove(context, toolCall.toolName)) return undefined;

      const requestId = ApprovalRequestId.make(await uuidPromise());
      const runtimeRequestId = RuntimeRequestId.make(requestId);
      const decision = new Promise<ProviderApprovalDecision>((resolve) => {
        context.pendingApprovals.set(requestId, { toolName: toolCall.toolName, resolve });
      });
      await offerPromise(
        makePiRequestOpenedEvent({
          stamp: await stampPromise(),
          identity: identity(context),
          requestId: runtimeRequestId,
          toolName: toolCall.toolName,
          args: toolCall.args,
        }),
      );
      const resolved = await decision;
      context.pendingApprovals.delete(requestId);
      if (resolved === "acceptForSession") context.approvedTools.add(toolCall.toolName);
      await offerPromise(
        makePiRequestResolvedEvent({
          stamp: await stampPromise(),
          identity: identity(context),
          requestId: runtimeRequestId,
          toolName: toolCall.toolName,
          decision: resolved,
        }),
      );
      return resolved === "accept" || resolved === "acceptForSession"
        ? undefined
        : {
            block: true,
            reason: resolved === "cancel" ? "Cancelled by the user." : "Declined by the user.",
          };
    };

    const recordTurnItem = (context: NativePiSessionContext, event: ProviderRuntimeEvent) => {
      const turnId = context.activeTurnId;
      if (!turnId || !event.type.startsWith("item.")) return;
      const turn = context.turns.find((candidate) => candidate.id === turnId);
      if (turn) turn.items.push(event);
    };

    const emit = async (context: NativePiSessionContext, event: ProviderRuntimeEvent) => {
      recordTurnItem(context, event);
      await offerPromise(event);
    };

    const completeOpenContentItems = async (context: NativePiSessionContext) => {
      for (const [contentIndex, item] of context.contentItems) {
        await emit(
          context,
          makePiItemEvent({
            stamp: await stampPromise(),
            identity: identity(context),
            lifecycle: "item.completed",
            itemId: item.id,
            itemType: item.itemType,
          }),
        );
        context.contentItems.delete(contentIndex);
      }
    };

    const settleActiveTurn = async (
      context: NativePiSessionContext,
      outcome?: ReturnType<typeof assistantOutcome>,
    ) => {
      const turnId = context.activeTurnId;
      if (!turnId) return;
      await completeOpenContentItems(context);
      const durationMs =
        context.activeTurnStartedAt === undefined
          ? undefined
          : Math.max(0, (await nowMillisPromise()) - context.activeTurnStartedAt);
      const abortReason = context.abortReason;
      let settlementEvent: ProviderRuntimeEvent;
      if (abortReason) {
        settlementEvent = {
          type: "turn.aborted",
          ...(await stampPromise()),
          ...identity(context),
          turnId,
          payload: { reason: abortReason },
        };
      } else {
        const settled = outcome ?? assistantOutcome(context.session.messages);
        settlementEvent = {
          type: "turn.completed",
          ...(await stampPromise()),
          ...identity(context),
          turnId,
          payload: {
            ...settled,
            ...(settled.usage === undefined
              ? durationMs === undefined
                ? {}
                : { usage: { durationMs } }
              : {
                  usage: {
                    provider: settled.usage,
                    ...(durationMs === undefined ? {} : { durationMs }),
                  },
                }),
          },
        };
      }
      context.providerSession = {
        ...context.providerSession,
        status: "ready",
        activeTurnId: undefined,
        updatedAt: await nowIsoPromise(),
      };
      context.activeTurnId = undefined;
      context.activeTurnStartedAt = undefined;
      context.abortReason = undefined;
      await offerPromise(settlementEvent);
    };

    const processSessionEvent = async (
      context: NativePiSessionContext,
      event: AgentSessionEvent,
    ): Promise<void> => {
      switch (event.type) {
        case "message_update": {
          const update = event.assistantMessageEvent;
          switch (update.type) {
            case "text_start":
            case "thinking_start": {
              const item: ContentItemState = {
                id: await uuidPromise(),
                itemType: update.type === "text_start" ? "assistant_message" : "reasoning",
              };
              context.contentItems.set(update.contentIndex, item);
              await emit(
                context,
                makePiItemEvent({
                  stamp: await stampPromise(),
                  identity: identity(context),
                  lifecycle: "item.started",
                  itemId: item.id,
                  itemType: item.itemType,
                }),
              );
              return;
            }
            case "text_delta":
            case "thinking_delta": {
              let item = context.contentItems.get(update.contentIndex);
              if (!item) {
                item = {
                  id: await uuidPromise(),
                  itemType: update.type === "text_delta" ? "assistant_message" : "reasoning",
                };
                context.contentItems.set(update.contentIndex, item);
                await emit(
                  context,
                  makePiItemEvent({
                    stamp: await stampPromise(),
                    identity: identity(context),
                    lifecycle: "item.started",
                    itemId: item.id,
                    itemType: item.itemType,
                  }),
                );
              }
              await offerPromise(
                makePiContentDeltaEvent({
                  stamp: await stampPromise(),
                  identity: identity(context),
                  itemId: item.id,
                  streamKind: update.type === "text_delta" ? "assistant_text" : "reasoning_text",
                  delta: update.delta,
                  contentIndex: update.contentIndex,
                  rawPayload: update,
                }),
              );
              return;
            }
            case "text_end":
            case "thinking_end": {
              const item = context.contentItems.get(update.contentIndex);
              if (!item) return;
              await emit(
                context,
                makePiItemEvent({
                  stamp: await stampPromise(),
                  identity: identity(context),
                  lifecycle: "item.completed",
                  itemId: item.id,
                  itemType: item.itemType,
                }),
              );
              context.contentItems.delete(update.contentIndex);
              return;
            }
            default:
              return;
          }
        }
        case "tool_execution_start":
          context.toolArgs.set(event.toolCallId, event.args);
          await emit(
            context,
            makePiToolEvent({
              stamp: await stampPromise(),
              identity: identity(context),
              lifecycle: "item.started",
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              args: event.args,
            }),
          );
          return;
        case "tool_execution_update":
          context.toolArgs.set(event.toolCallId, event.args);
          await emit(
            context,
            makePiToolEvent({
              stamp: await stampPromise(),
              identity: identity(context),
              lifecycle: "item.updated",
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              args: event.args,
              result: event.partialResult,
            }),
          );
          return;
        case "tool_execution_end": {
          const args = context.toolArgs.get(event.toolCallId) ?? {};
          context.toolArgs.delete(event.toolCallId);
          await emit(
            context,
            makePiToolEvent({
              stamp: await stampPromise(),
              identity: identity(context),
              lifecycle: "item.completed",
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              args,
              result: event.result,
              isError: event.isError,
            }),
          );
          return;
        }
        case "entry_appended": {
          const turnId = context.activeTurnId;
          const turn = turnId
            ? context.turns.find((candidate) => candidate.id === turnId)
            : undefined;
          if (turn) turn.entryIds.push(event.entry.id);
          return;
        }
        case "session_info_changed":
          if (!event.name) return;
          await offerPromise({
            type: "thread.metadata.updated",
            ...(await stampPromise()),
            ...identity(context),
            payload: { name: event.name },
          });
          return;
        case "compaction_start": {
          const itemId = await uuidPromise();
          context.compactionItemId = itemId;
          await emit(
            context,
            makePiItemEvent({
              stamp: await stampPromise(),
              identity: identity(context),
              lifecycle: "item.started",
              itemId,
              itemType: "context_compaction",
              data: { kind: "context_compaction", reason: event.reason },
            }),
          );
          return;
        }
        case "compaction_end": {
          const itemId = context.compactionItemId;
          if (!itemId) return;
          await emit(
            context,
            makePiItemEvent({
              stamp: await stampPromise(),
              identity: identity(context),
              lifecycle: "item.completed",
              itemId,
              itemType: "context_compaction",
              status: event.errorMessage ? "failed" : "completed",
              data: {
                kind: "context_compaction",
                reason: event.reason,
                aborted: event.aborted,
                ...(event.errorMessage ? { errorMessage: event.errorMessage } : {}),
              },
            }),
          );
          context.compactionItemId = undefined;
          return;
        }
        case "auto_retry_start":
          await offerPromise({
            type: "runtime.warning",
            ...(await stampPromise()),
            ...identity(context),
            payload: {
              message: `Pi retry ${event.attempt}/${event.maxAttempts}`,
              detail: { delayMs: event.delayMs, errorMessage: event.errorMessage },
            },
          });
          return;
        case "auto_retry_end":
          if (event.success || !event.finalError) return;
          await offerPromise({
            type: "runtime.error",
            ...(await stampPromise()),
            ...identity(context),
            payload: { message: event.finalError, class: "provider_error" },
          });
          return;
        case "agent_settled":
          await settleActiveTurn(context);
          return;
        default:
          return;
      }
    };

    const queueSessionEvent = (context: NativePiSessionContext, event: AgentSessionEvent) => {
      context.eventChain = context.eventChain
        .then(() => processSessionEvent(context, event))
        .catch(async (cause: unknown) => {
          await offerPromise({
            type: "runtime.error",
            ...(await stampPromise()),
            ...identity(context),
            payload: {
              message: cause instanceof Error ? cause.message : String(cause),
              class: "unknown",
            },
          });
        });
    };

    const replayHistory = async (context: NativePiSessionContext) => {
      for (const message of context.session.messages) {
        const role = messageRole(message);
        if (role === "user") {
          const text = messageText(message).trim();
          if (!text) continue;
          await offerPromise(
            makePiContentDeltaEvent({
              stamp: await stampPromise(),
              identity: { ...identity(context), turnId: undefined },
              streamKind: "user_text",
              delta: text,
              rawPayload: message,
            }),
          );
          continue;
        }
        if (role !== "assistant" || !isRecord(message) || !Array.isArray(message.content)) continue;
        for (const [contentIndex, block] of message.content.entries()) {
          if (!isRecord(block)) continue;
          const isText = block.type === "text" && typeof block.text === "string";
          const isThinking = block.type === "thinking" && typeof block.thinking === "string";
          if (!isText && !isThinking) continue;
          const text = isText ? String(block.text) : String(block.thinking);
          if (!text.trim()) continue;
          const itemId = await uuidPromise();
          const itemType = isText ? "assistant_message" : "reasoning";
          const historyIdentity = { ...identity(context), turnId: undefined };
          await offerPromise(
            makePiItemEvent({
              stamp: await stampPromise(),
              identity: historyIdentity,
              lifecycle: "item.started",
              itemId,
              itemType,
            }),
          );
          await offerPromise(
            makePiContentDeltaEvent({
              stamp: await stampPromise(),
              identity: historyIdentity,
              itemId,
              streamKind: isText ? "assistant_text" : "reasoning_text",
              delta: text,
              contentIndex,
              rawPayload: block,
            }),
          );
          await offerPromise(
            makePiItemEvent({
              stamp: await stampPromise(),
              identity: historyIdentity,
              lifecycle: "item.completed",
              itemId,
              itemType,
            }),
          );
        }
      }
    };

    const findResumePath = (input: {
      readonly cursor: ReturnType<typeof parseResumeCursor>;
      readonly cwd: string;
    }) => {
      const cursor = input.cursor;
      if (!cursor) return Effect.sync((): string | undefined => undefined);
      if (cursor.path) return Effect.succeed(cursor.path);
      return Effect.tryPromise({
        try: async () => {
          const candidates = await sdk.listSessions(input.cwd);
          return candidates.find((candidate) => candidate.id === cursor.sessionId)?.path;
        },
        catch: (cause) => requestError("SessionManager.list", cause),
      }).pipe(
        Effect.flatMap((resumePath) =>
          resumePath
            ? Effect.succeed(resumePath)
            : Effect.fail(
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session/resume",
                  detail: `Pi session '${cursor.sessionId}' was not found.`,
                }),
              ),
        ),
      );
    };

    const resolveSelection = (input: {
      readonly threadId: ThreadId;
      readonly modelSelection: ModelSelection | undefined;
    }): Effect.Effect<
      { readonly model: PiModel | undefined; readonly thinkingLevel: PiThinkingLevel | undefined },
      ProviderAdapterValidationError
    > => {
      const selection = input.modelSelection;
      if (!selection || selection.instanceId !== options.instanceId) {
        return Effect.succeed({ model: undefined, thinkingLevel: undefined });
      }
      const resolved =
        selection.model === "default" ? undefined : sdk.resolveModel(selection.model);
      if (resolved?.error) {
        return Effect.fail(
          new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "modelSelection",
            issue: resolved.error,
          }),
        );
      }
      const thinkingLevel = piThinkingLevel(
        getProviderOptionStringSelectionValue(selection.options, "reasoningEffort"),
      );
      return Effect.succeed({ model: resolved?.model, thinkingLevel });
    };

    const closeSession = (context: NativePiSessionContext) =>
      Effect.gen(function* () {
        if (context.stopped) return;
        context.stopped = true;
        if (context.activeTurnId && !context.abortReason) {
          context.abortReason = "Pi session stopped.";
        }
        for (const pending of context.pendingApprovals.values()) pending.resolve("cancel");
        context.pendingApprovals.clear();
        if (context.session.isStreaming) {
          yield* Effect.tryPromise({
            try: () => context.session.abort(),
            catch: (cause) => requestError("session.abort", cause),
          }).pipe(Effect.ignore);
        }
        context.unsubscribe?.();
        context.unsubscribe = undefined;
        yield* Effect.promise(() => context.eventChain);
        if (context.activeTurnId) {
          yield* Effect.promise(() => settleActiveTurn(context));
        }
        if (context.session.shutdown) {
          yield* Effect.tryPromise({
            try: () => context.session.shutdown!(),
            catch: (cause) => requestError("session.shutdown", cause),
          }).pipe(Effect.ignore);
        }
        yield* Effect.try({
          try: () => context.session.dispose(),
          catch: (cause) => requestError("session.dispose", cause),
        }).pipe(Effect.ignore);
        if (
          context.reservedSessionPath &&
          openPiSessionFiles.get(context.reservedSessionPath) ===
            `${options.instanceId}:${context.threadId}`
        ) {
          openPiSessionFiles.delete(context.reservedSessionPath);
        }
        sessions.delete(context.threadId);
        yield* offer({
          type: "session.exited",
          ...(yield* makeStamp()),
          ...identity(context),
          turnId: undefined,
          payload: { exitKind: "graceful" },
        });
      });

    const startSessionUnlocked: ProviderAdapterShape<ProviderAdapterError>["startSession"] = (
      input,
    ) =>
      Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== PROVIDER) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          });
        }
        if (
          input.providerInstanceId !== undefined &&
          input.providerInstanceId !== options.instanceId
        ) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider instance '${options.instanceId}' but received '${input.providerInstanceId}'.`,
          });
        }
        if (!options.enabled) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "Native Pi is disabled for this provider instance.",
          });
        }
        const cwd = input.cwd?.trim();
        if (!cwd) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "cwd is required and must be non-empty.",
          });
        }
        const previous = sessions.get(input.threadId);
        if (previous) yield* closeSession(previous);

        const resolvedCwd = path.resolve(cwd);
        const selection = yield* resolveSelection({
          threadId: input.threadId,
          modelSelection: input.modelSelection,
        });
        const resumeCursor = parseResumeCursor(input.resumeCursor);
        const resumePath = yield* findResumePath({ cursor: resumeCursor, cwd: resolvedCwd });
        const reservationOwner = `${options.instanceId}:${input.threadId}`;
        const resumeReservationPath = resumePath ? path.resolve(resumePath) : undefined;
        const existingOwner = resumeReservationPath
          ? openPiSessionFiles.get(resumeReservationPath)
          : undefined;
        if (existingOwner && existingOwner !== reservationOwner) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "This Pi session is already open in another T3 thread.",
          });
        }
        if (resumeReservationPath) {
          openPiSessionFiles.set(resumeReservationPath, reservationOwner);
        }
        let context: NativePiSessionContext | undefined;
        const session = yield* Effect.tryPromise({
          try: () =>
            sdk.createSession({
              cwd: resolvedCwd,
              resumePath,
              model: selection.model,
              thinkingLevel: selection.thinkingLevel,
              authorizeTool: (toolCall) =>
                context
                  ? authorizeTool(context, toolCall)
                  : Promise.resolve({ block: true, reason: "Pi session is still starting." }),
            }),
          catch: (cause) => requestError("createAgentSession", cause),
        }).pipe(
          Effect.tapError(() =>
            Effect.sync(() => {
              if (
                resumeReservationPath &&
                openPiSessionFiles.get(resumeReservationPath) === reservationOwner
              ) {
                openPiSessionFiles.delete(resumeReservationPath);
              }
            }),
          ),
        );
        const reservedSessionPath = session.sessionFile
          ? path.resolve(session.sessionFile)
          : resumeReservationPath;
        if (reservedSessionPath && reservedSessionPath !== resumeReservationPath) {
          const owner = openPiSessionFiles.get(reservedSessionPath);
          if (owner && owner !== reservationOwner) {
            session.dispose();
            if (
              resumeReservationPath &&
              openPiSessionFiles.get(resumeReservationPath) === reservationOwner
            ) {
              openPiSessionFiles.delete(resumeReservationPath);
            }
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "This Pi session is already open in another T3 thread.",
            });
          }
          if (
            resumeReservationPath &&
            openPiSessionFiles.get(resumeReservationPath) === reservationOwner
          ) {
            openPiSessionFiles.delete(resumeReservationPath);
          }
          openPiSessionFiles.set(reservedSessionPath, reservationOwner);
        }
        const now = yield* nowIso;
        const model = session.model ? `${session.model.provider}/${session.model.id}` : undefined;
        const providerSession: ProviderSession = {
          provider: PROVIDER,
          providerInstanceId: options.instanceId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          cwd: resolvedCwd,
          ...(model ? { model } : {}),
          threadId: input.threadId,
          resumeCursor: {
            schemaVersion: PI_RESUME_VERSION,
            sessionId: session.sessionId,
            ...(session.sessionFile ? { path: session.sessionFile } : {}),
          },
          createdAt: now,
          updatedAt: now,
        };
        context = {
          threadId: input.threadId,
          session,
          pendingApprovals: new Map(),
          approvedTools: new Set(),
          turns: [],
          contentItems: new Map(),
          toolArgs: new Map(),
          initialEntryId: session.getLeafId() ?? undefined,
          reservedSessionPath,
          runtimeMode: input.runtimeMode,
          providerSession,
          unsubscribe: undefined,
          activeTurnId: undefined,
          activeTurnStartedAt: undefined,
          compactionItemId: undefined,
          abortReason: undefined,
          eventChain: Promise.resolve(),
          stopped: false,
        };
        context.unsubscribe = session.subscribe((event) => queueSessionEvent(context!, event));
        sessions.set(input.threadId, context);
        yield* offer({
          type: "session.started",
          ...(yield* makeStamp()),
          provider: PROVIDER,
          providerInstanceId: options.instanceId,
          threadId: input.threadId,
          payload: {
            message: "Embedded Pi SDK session ready",
            resume: providerSession.resumeCursor,
          },
        });
        yield* offer({
          type: "thread.started",
          ...(yield* makeStamp()),
          provider: PROVIDER,
          providerInstanceId: options.instanceId,
          threadId: input.threadId,
          payload: { providerThreadId: session.sessionId },
        });
        if (input.importHistory === true && resumePath) {
          yield* Effect.tryPromise({
            try: () => replayHistory(context!),
            catch: (cause) => requestError("session/importHistory", cause),
          });
        }
        return providerSession;
      });

    const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = (input) =>
      withThreadLock(input.threadId, startSessionUnlocked(input));

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<NativePiSessionContext, ProviderAdapterSessionNotFoundError> => {
      const context = sessions.get(threadId);
      return context && !context.stopped
        ? Effect.succeed(context)
        : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
    };

    const applySelection = (
      context: NativePiSessionContext,
      selection: ModelSelection | undefined,
    ) =>
      Effect.gen(function* () {
        const resolved = yield* resolveSelection({
          threadId: context.threadId,
          modelSelection: selection,
        });
        if (resolved.model) {
          const current = context.session.model;
          if (
            !current ||
            current.provider !== resolved.model.provider ||
            current.id !== resolved.model.id
          ) {
            yield* Effect.tryPromise({
              try: () => context.session.setModel(resolved.model!),
              catch: (cause) => requestError("session.setModel", cause),
            });
          }
        }
        if (resolved.thinkingLevel && context.session.thinkingLevel !== resolved.thinkingLevel) {
          context.session.setThinkingLevel(resolved.thinkingLevel);
        }
      });

    const resolveImages = (
      _context: NativePiSessionContext,
      attachments: Parameters<
        ProviderAdapterShape<ProviderAdapterError>["sendTurn"]
      >[0]["attachments"],
    ) =>
      Effect.forEach(
        attachments ?? [],
        (
          attachment,
        ): Effect.Effect<
          PiPromptImage,
          ProviderAdapterValidationError | ProviderAdapterRequestError
        > => {
          if (!isPiMediaType(attachment.mimeType)) {
            return Effect.fail(
              new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "sendTurn",
                issue: `Pi does not support image type '${attachment.mimeType}'.`,
              }),
            );
          }
          const attachmentPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          });
          if (!attachmentPath) {
            return Effect.fail(
              new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "sendTurn",
                issue: `Attachment '${attachment.id}' could not be resolved.`,
              }),
            );
          }
          return fileSystem.readFile(attachmentPath).pipe(
            Effect.map(
              (bytes): PiPromptImage => ({
                type: "image",
                mimeType: attachment.mimeType,
                data: Buffer.from(bytes).toString("base64"),
              }),
            ),
            Effect.mapError((cause) => requestError(`attachment.read:${attachment.id}`, cause)),
          );
        },
      );

    const sendTurnUnlocked: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const context = yield* requireSession(input.threadId);
        const isSteering = context.activeTurnId !== undefined || context.session.isStreaming;
        if (!isSteering) {
          yield* applySelection(context, input.modelSelection);
        }
        const images = yield* resolveImages(context, input.attachments);
        const rawText = input.input?.trim() ?? "";
        const text =
          input.interactionMode === "plan"
            ? `Work in plan mode. Analyze and propose a concrete plan before making changes.\n\n${rawText || "Analyze the attached material."}`
            : rawText || "Analyze the attached image.";
        if (context.activeTurnId) {
          yield* Effect.promise(() => context.eventChain);
          if (context.activeTurnId) {
            context.abortReason = "Superseded by a steering message.";
            yield* Effect.promise(() => settleActiveTurn(context));
          }
        }
        const turnId = TurnId.make(yield* nextUuid);
        context.activeTurnId = turnId;
        context.activeTurnStartedAt = yield* Clock.currentTimeMillis;
        context.abortReason = undefined;
        context.turns.push({ id: turnId, items: [], entryIds: [] });
        context.providerSession = {
          ...context.providerSession,
          status: "running",
          activeTurnId: turnId,
          updatedAt: yield* nowIso,
          ...(context.session.model
            ? { model: `${context.session.model.provider}/${context.session.model.id}` }
            : {}),
        };
        yield* offer({
          type: "turn.started",
          ...(yield* makeStamp()),
          ...identity(context),
          turnId,
          payload: {
            ...(context.providerSession.model ? { model: context.providerSession.model } : {}),
            effort: context.session.thinkingLevel,
          },
        });
        const promptOptions: PiPromptOptions =
          images.length > 0 || isSteering
            ? {
                ...(images.length > 0 ? { images } : {}),
                ...(isSteering ? { streamingBehavior: "steer" as const } : {}),
              }
            : undefined;
        void context.session.prompt(text, promptOptions).then(
          () => {
            context.eventChain = context.eventChain.then(async () => {
              if (context.activeTurnId === turnId && !context.session.isStreaming) {
                await settleActiveTurn(context);
              }
            });
          },
          (cause: unknown) => {
            context.eventChain = context.eventChain.then(async () => {
              if (context.activeTurnId !== turnId) return;
              const message = cause instanceof Error ? cause.message : String(cause);
              await offerPromise({
                type: "runtime.error",
                ...(await stampPromise()),
                ...identity(context),
                turnId,
                payload: { message, class: "provider_error" },
              });
              await settleActiveTurn(context, { state: "failed", errorMessage: message });
            });
          },
        );
        return {
          threadId: input.threadId,
          turnId,
          resumeCursor: context.providerSession.resumeCursor,
        };
      });

    const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = (input) =>
      withThreadLock(input.threadId, sendTurnUnlocked(input));

    const interruptTurn: ProviderAdapterShape<ProviderAdapterError>["interruptTurn"] = (
      threadId,
      turnId,
    ) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        if (!context.activeTurnId) return;
        if (turnId && turnId !== context.activeTurnId) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "interruptTurn",
            issue: `Turn '${turnId}' is not active.`,
          });
        }
        context.abortReason = "Interrupted by the user.";
        yield* Effect.tryPromise({
          try: () => context.session.abort(),
          catch: (cause) => requestError("session.abort", cause),
        });
      });

    const respondToRequest: ProviderAdapterShape<ProviderAdapterError>["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const pending = context.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "respondToRequest",
            issue: `Approval request '${requestId}' is no longer pending.`,
          });
        }
        context.pendingApprovals.delete(requestId);
        pending.resolve(decision);
      });

    const respondToUserInput: ProviderAdapterShape<ProviderAdapterError>["respondToUserInput"] = (
      threadId,
      requestId,
      _answers: ProviderUserInputAnswers,
    ) =>
      requireSession(threadId).pipe(
        Effect.flatMap(() =>
          Effect.fail(
            new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "respondToUserInput",
              issue: `Pi has no pending structured input request '${requestId}'.`,
            }),
          ),
        ),
      );

    const readThread: ProviderAdapterShape<ProviderAdapterError>["readThread"] = (threadId) =>
      requireSession(threadId).pipe(
        Effect.map((context) => ({
          threadId,
          turns: context.turns.map((turn) => ({ id: turn.id, items: [...turn.items] })),
        })),
      );

    const rollbackThread: ProviderAdapterShape<ProviderAdapterError>["rollbackThread"] = (
      threadId,
      numTurns,
    ) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns <= 0 || numTurns > context.turns.length) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: `Cannot roll back ${numTurns} turn(s).`,
          });
        }
        const keepCount = context.turns.length - numTurns;
        const targetTurn = context.turns[keepCount - 1];
        const targetEntryId = targetTurn?.entryIds.at(-1);
        const navigationTarget = targetEntryId ?? context.initialEntryId;
        if (navigationTarget) {
          const navigation = yield* Effect.tryPromise({
            try: () => context.session.navigateTree(navigationTarget),
            catch: (cause) => requestError("session.navigateTree", cause),
          });
          if (navigation.cancelled) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session.navigateTree",
              detail: "Pi cancelled the conversation rollback.",
            });
          }
        } else {
          yield* Effect.try({
            try: () => context.session.resetLeaf(),
            catch: (cause) => requestError("session.resetLeaf", cause),
          });
        }
        context.turns.splice(keepCount);
        return {
          threadId,
          turns: context.turns.map((turn) => ({ id: turn.id, items: [...turn.items] })),
        };
      });

    const listNativeSessions: NonNullable<
      ProviderAdapterShape<ProviderAdapterError>["listNativeSessions"]
    > = (cwd) =>
      Effect.tryPromise({
        try: () => sdk.listSessions(cwd),
        catch: (cause) => requestError("SessionManager.list", cause),
      }).pipe(
        Effect.map((entries) =>
          entries.map((entry) => ({
            provider: PROVIDER,
            providerInstanceId: options.instanceId,
            sessionId: entry.id,
            cwd: entry.cwd || cwd || process.cwd(),
            ...(entry.name || entry.firstMessage
              ? { title: (entry.name || entry.firstMessage).trim().slice(0, 200) }
              : {}),
            updatedAt: entry.modified.toISOString(),
          })),
        ),
      );

    const stopAll = () =>
      Effect.forEach([...sessions.values()], closeSession, { discard: true, concurrency: 1 });

    const adapter: ProviderAdapterShape<ProviderAdapterError> = {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session" },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession: (threadId) => requireSession(threadId).pipe(Effect.flatMap(closeSession)),
      listSessions: () =>
        Effect.succeed([...sessions.values()].map((context) => context.providerSession)),
      listNativeSessions,
      hasSession: (threadId) => Effect.succeed(sessions.has(threadId)),
      readThread,
      rollbackThread,
      stopAll,
      streamEvents: Stream.fromPubSub(runtimeEvents),
    };

    yield* Effect.addFinalizer(() => stopAll().pipe(Effect.ignore));
    return adapter;
  });
}
