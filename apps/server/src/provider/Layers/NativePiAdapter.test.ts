// @effect-diagnostics outdatedApi:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { AgentSessionEvent, SessionInfo } from "@earendil-works/pi-coding-agent";
import {
  ApprovalRequestId,
  ProviderInstanceId,
  ThreadId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import {
  makeNativePiAdapter,
  type NativePiSdk,
  type NativePiSession,
  type NativePiSessionFactoryInput,
} from "./NativePiAdapter.ts";

type PiMessageUpdate = Extract<AgentSessionEvent, { readonly type: "message_update" }>;
type PiAssistantMessage = Extract<PiMessageUpdate["message"], { readonly role: "assistant" }>;

function assistantMessage(content: PiAssistantMessage["content"] = []): PiAssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "openai",
    model: "test-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  };
}

function entryAppended(id: string, parentId: string | null): AgentSessionEvent {
  return {
    type: "entry_appended",
    entry: {
      type: "message",
      id,
      parentId,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: id, timestamp: 0 },
    },
  };
}

function makeFakeHarness(options?: {
  readonly initialLeafId?: string | null;
  readonly nativeSessions?: ReadonlyArray<SessionInfo>;
  readonly messages?: NativePiSession["messages"];
  readonly sessionFile?: string;
  readonly extensionToolNames?: ReadonlySet<string>;
}) {
  const listeners: Array<Parameters<NativePiSession["subscribe"]>[0]> = [];
  const state = {
    abortCalls: 0,
    createInputs: [] as NativePiSessionFactoryInput[],
    isStreaming: false,
    listCwds: [] as Array<string | undefined>,
    model: undefined as NativePiSession["model"],
    navigateCalls: [] as string[],
    promptCalls: [] as Array<Parameters<NativePiSession["prompt"]>>,
    resetCalls: 0,
    shutdownCalls: 0,
    setModelCalls: 0,
    messages: options?.messages ?? [],
    onAbort: async () => {},
    onSetModel: async (_model: NonNullable<NativePiSession["model"]>) => {},
    onPrompt: async () => {
      await emit({ type: "agent_settled" });
    },
  };

  async function emit(event: AgentSessionEvent) {
    for (const listener of [...listeners]) listener(event);
  }

  const session: NativePiSession = {
    sessionId: "pi-session-1",
    sessionFile: options?.sessionFile ?? "/tmp/pi-session-1.jsonl",
    ...(options?.extensionToolNames ? { extensionToolNames: options.extensionToolNames } : {}),
    get model() {
      return state.model;
    },
    thinkingLevel: "off",
    get isStreaming() {
      return state.isStreaming;
    },
    get messages() {
      return state.messages;
    },
    prompt: async (...input) => {
      state.promptCalls.push(input);
      await state.onPrompt();
    },
    abort: async () => {
      state.abortCalls += 1;
      await state.onAbort();
    },
    dispose: () => {},
    shutdown: async () => {
      state.shutdownCalls += 1;
    },
    subscribe: (listener) => {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
    setModel: async (model) => {
      state.setModelCalls += 1;
      await state.onSetModel(model);
      state.model = model;
    },
    setThinkingLevel: () => {},
    navigateTree: async (targetId) => {
      state.navigateCalls.push(targetId);
      return { cancelled: false };
    },
    getLeafId: () => options?.initialLeafId ?? null,
    resetLeaf: () => {
      state.resetCalls += 1;
    },
  };

  const sdk: NativePiSdk = {
    createSession: async (input) => {
      state.createInputs.push(input);
      return session;
    },
    listSessions: async (cwd) => {
      state.listCwds.push(cwd);
      return options?.nativeSessions ?? [];
    },
    resolveModel: (slug) => ({ error: `Unexpected model resolution: ${slug}` }),
  };

  return { emit, sdk, session, state };
}

const testLayer = Layer.mergeAll(
  NodeServices.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-native-pi-adapter-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
);

const INSTANCE_ID = ProviderInstanceId.make("piAgent");

it.layer(testLayer)("NativePiAdapter", (it) => {
  it.effect("runs an embedded Pi turn and settles it exactly once", () =>
    Effect.gen(function* () {
      const harness = makeFakeHarness();
      const adapter = yield* makeNativePiAdapter({
        instanceId: INSTANCE_ID,
        enabled: true,
        sdk: harness.sdk,
      });
      const eventsFiber = yield* Stream.take(adapter.streamEvents, 4).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;

      const threadId = ThreadId.make("thread-native-pi");
      const session = yield* adapter.startSession({
        threadId,
        providerInstanceId: INSTANCE_ID,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({ threadId, input: "Hello from T3" });
      const events = yield* Fiber.join(eventsFiber);

      assert.strictEqual(session.resumeCursor !== undefined, true);
      assert.strictEqual(turn.threadId, threadId);
      assert.deepStrictEqual(
        events.map((event) => event.type),
        ["session.started", "thread.started", "turn.started", "turn.completed"],
      );
    }),
  );

  it.effect("maps Pi text, reasoning and tool events without duplicate settlement", () =>
    Effect.gen(function* () {
      const harness = makeFakeHarness();
      const assistant = assistantMessage();
      harness.state.onPrompt = async () => {
        for (const event of [
          {
            type: "message_update",
            message: assistant,
            assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: assistant },
          },
          {
            type: "message_update",
            message: assistant,
            assistantMessageEvent: {
              type: "text_delta",
              contentIndex: 0,
              delta: "answer",
              partial: assistant,
            },
          },
          {
            type: "message_update",
            message: assistant,
            assistantMessageEvent: {
              type: "text_end",
              contentIndex: 0,
              content: "answer",
              partial: assistant,
            },
          },
          {
            type: "message_update",
            message: assistant,
            assistantMessageEvent: { type: "thinking_start", contentIndex: 1, partial: assistant },
          },
          {
            type: "message_update",
            message: assistant,
            assistantMessageEvent: {
              type: "thinking_delta",
              contentIndex: 1,
              delta: "reasoning",
              partial: assistant,
            },
          },
          {
            type: "message_update",
            message: assistant,
            assistantMessageEvent: {
              type: "thinking_end",
              contentIndex: 1,
              content: "reasoning",
              partial: assistant,
            },
          },
          {
            type: "tool_execution_start",
            toolCallId: "tool-1",
            toolName: "bash",
            args: { command: "pwd" },
          },
          {
            type: "tool_execution_update",
            toolCallId: "tool-1",
            toolName: "bash",
            args: { command: "pwd" },
            partialResult: { output: "/tmp" },
          },
          {
            type: "tool_execution_end",
            toolCallId: "tool-1",
            toolName: "bash",
            result: { output: "/tmp" },
            isError: false,
          },
          { type: "agent_settled" },
          { type: "agent_settled" },
          { type: "session_info_changed", name: "Settled" },
        ] satisfies AgentSessionEvent[]) {
          await harness.emit(event);
        }
      };
      const adapter = yield* makeNativePiAdapter({
        instanceId: INSTANCE_ID,
        enabled: true,
        sdk: harness.sdk,
      });
      const observed: ProviderRuntimeEvent[] = [];
      const processed = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => observed.push(event)).pipe(
          Effect.andThen(
            event.type === "thread.metadata.updated"
              ? Deferred.succeed(processed, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);
      yield* Effect.yieldNow;

      const threadId = ThreadId.make("thread-streaming");
      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
      yield* adapter.sendTurn({ threadId, input: "Stream" });
      yield* Deferred.await(processed);
      yield* Fiber.interrupt(eventsFiber);

      assert.strictEqual(observed.filter((event) => event.type === "turn.completed").length, 1);
      assert.includeMembers(
        observed.map((event) => event.type),
        ["content.delta", "item.started", "item.updated", "item.completed"],
      );
      const completedTool = observed.find(
        (event) => event.type === "item.completed" && event.itemId === "tool-1",
      );
      if (!completedTool || completedTool.type !== "item.completed") {
        return yield* Effect.die("Missing completed tool event");
      }
      assert.deepInclude(completedTool.payload.data, {
        toolName: "bash",
        args: { command: "pwd" },
      });
      assert.strictEqual(completedTool.raw?.method, "tool_execution_end");
    }),
  );

  it.effect("resumes and imports Pi JSONL sessions", () =>
    Effect.gen(function* () {
      const nativeSession: SessionInfo = {
        id: "native-1",
        path: "/tmp/native-1.jsonl",
        cwd: process.cwd(),
        name: "Imported Pi session",
        created: DateTime.toDate(DateTime.makeUnsafe("2026-01-01T00:00:00.000Z")),
        modified: DateTime.toDate(DateTime.makeUnsafe("2026-01-02T00:00:00.000Z")),
        messageCount: 2,
        firstMessage: "Earlier question",
        allMessagesText: "Earlier question\nEarlier answer",
      };
      const harness = makeFakeHarness({
        nativeSessions: [nativeSession],
        messages: [
          { role: "user", content: "Earlier question", timestamp: 0 },
          assistantMessage([{ type: "text", text: "Earlier answer" }]),
        ],
      });
      const adapter = yield* makeNativePiAdapter({
        instanceId: INSTANCE_ID,
        enabled: true,
        sdk: harness.sdk,
      });
      const imported = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "content.delta" && event.payload.delta === "Earlier answer"
          ? Deferred.succeed(imported, undefined)
          : Effect.void,
      ).pipe(Effect.forkChild);
      yield* Effect.yieldNow;

      yield* adapter.startSession({
        threadId: ThreadId.make("thread-imported"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 1, sessionId: "native-1" },
        importHistory: true,
      });
      yield* Deferred.await(imported);
      const listNativeSessions = adapter.listNativeSessions;
      if (!listNativeSessions) return yield* Effect.die("Missing native session listing");
      const listed = yield* listNativeSessions();
      yield* Fiber.interrupt(eventsFiber);

      assert.strictEqual(harness.state.createInputs[0]?.resumePath, nativeSession.path);
      assert.strictEqual(listed?.[0]?.sessionId, "native-1");
      assert.strictEqual(listed?.[0]?.title, "Imported Pi session");
    }),
  );

  it.effect("routes image bytes to the Pi SDK prompt", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const attachmentId = "thread-image-00000000-0000-4000-8000-000000000001";
      yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true });
      yield* fileSystem.writeFile(
        path.join(config.attachmentsDir, `${attachmentId}.png`),
        new Uint8Array([1, 2, 3]),
      );
      const harness = makeFakeHarness();
      const adapter = yield* makeNativePiAdapter({
        instanceId: INSTANCE_ID,
        enabled: true,
        sdk: harness.sdk,
      });
      const completed = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "turn.completed" ? Deferred.succeed(completed, undefined) : Effect.void,
      ).pipe(Effect.forkChild);
      yield* Effect.yieldNow;

      const threadId = ThreadId.make("thread-image");
      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
      yield* adapter.sendTurn({
        threadId,
        attachments: [
          {
            type: "image",
            id: attachmentId,
            name: "image.png",
            mimeType: "image/png",
            sizeBytes: 3,
          },
        ],
      });
      yield* Deferred.await(completed);
      yield* Fiber.interrupt(eventsFiber);

      assert.deepStrictEqual(harness.state.promptCalls[0]?.[1]?.images, [
        { type: "image", mimeType: "image/png", data: "AQID" },
      ]);
    }),
  );

  it.effect("honors approval decisions and acceptForSession", () =>
    Effect.gen(function* () {
      const harness = makeFakeHarness();
      const authorizationResults: Array<
        { readonly block?: boolean; readonly reason?: string } | undefined
      > = [];
      harness.state.onPrompt = async () => {
        const authorize = harness.state.createInputs[0]?.authorizeTool;
        if (!authorize) throw new Error("Missing authorization callback");
        authorizationResults.push(
          await authorize({
            toolCallId: `bash-${authorizationResults.length}`,
            toolName: "bash",
            args: { command: "pwd" },
          }),
        );
        await harness.emit({ type: "agent_settled" });
      };
      const adapter = yield* makeNativePiAdapter({
        instanceId: INSTANCE_ID,
        enabled: true,
        sdk: harness.sdk,
      });
      const events: ProviderRuntimeEvent[] = [];
      const opened = yield* Deferred.make<ProviderRuntimeEvent>();
      const firstCompleted = yield* Deferred.make<void>();
      const twiceCompleted = yield* Deferred.make<void>();
      let completedCount = 0;
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          events.push(event);
          if (event.type === "turn.completed") completedCount += 1;
          if (event.type === "request.opened") yield* Deferred.succeed(opened, event);
          if (completedCount === 1) yield* Deferred.succeed(firstCompleted, undefined);
          if (completedCount === 2) yield* Deferred.succeed(twiceCompleted, undefined);
        }),
      ).pipe(Effect.forkChild);
      yield* Effect.yieldNow;

      const threadId = ThreadId.make("thread-approval");
      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* adapter.sendTurn({ threadId, input: "First command" });
      const approval = yield* Deferred.await(opened);
      if (approval.type !== "request.opened") return yield* Effect.die("Unexpected event type");
      if (!approval.requestId) return yield* Effect.die("Missing approval request id");
      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(approval.requestId),
        "acceptForSession" satisfies ProviderApprovalDecision,
      );
      yield* Deferred.await(firstCompleted);
      yield* adapter.sendTurn({ threadId, input: "Second command" });
      yield* Deferred.await(twiceCompleted);
      yield* Fiber.interrupt(eventsFiber);

      assert.deepStrictEqual(authorizationResults, [undefined, undefined]);
      assert.strictEqual(events.filter((event) => event.type === "request.opened").length, 1);
      assert.include(
        events.map((event) => event.type),
        "request.resolved",
      );
    }),
  );

  it.effect("settles a handled Pi input that never starts an agent run", () =>
    Effect.gen(function* () {
      const harness = makeFakeHarness();
      harness.state.onPrompt = async () => {};
      const adapter = yield* makeNativePiAdapter({
        instanceId: INSTANCE_ID,
        enabled: true,
        sdk: harness.sdk,
      });
      const completed = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "turn.completed" ? Deferred.succeed(completed, undefined) : Effect.void,
      ).pipe(Effect.forkChild);
      yield* Effect.yieldNow;

      const threadId = ThreadId.make("thread-handled-input");
      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
      yield* adapter.sendTurn({ threadId, input: "/handled-by-extension" });
      yield* Deferred.await(completed);
      yield* Fiber.interrupt(eventsFiber);

      const sessions = yield* adapter.listSessions();
      assert.strictEqual(sessions[0]?.status, "ready");
      assert.strictEqual(sessions[0]?.activeTurnId, undefined);
    }),
  );

  it.effect("serializes concurrent starts for the same T3 thread", () =>
    Effect.gen(function* () {
      const harness = makeFakeHarness();
      let markFirstCreateEntered: (() => void) | undefined;
      let releaseFirstCreate: (() => void) | undefined;
      const firstCreateEntered = new Promise<void>((resolve) => {
        markFirstCreateEntered = resolve;
      });
      const firstCreateRelease = new Promise<void>((resolve) => {
        releaseFirstCreate = resolve;
      });
      let createCalls = 0;
      const sdk: NativePiSdk = {
        ...harness.sdk,
        createSession: async (input) => {
          harness.state.createInputs.push(input);
          createCalls += 1;
          if (createCalls === 1) {
            markFirstCreateEntered?.();
            await firstCreateRelease;
          }
          return harness.session;
        },
      };
      const adapter = yield* makeNativePiAdapter({
        instanceId: INSTANCE_ID,
        enabled: true,
        sdk,
      });
      const threadId = ThreadId.make("thread-concurrent-start");
      const start = () =>
        adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });

      const first = yield* start().pipe(Effect.forkChild);
      yield* Effect.promise(() => firstCreateEntered);
      const second = yield* start().pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      assert.strictEqual(createCalls, 1);

      releaseFirstCreate?.();
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      assert.strictEqual(createCalls, 2);
      assert.strictEqual(harness.state.shutdownCalls, 1);
    }),
  );

  it.effect("reserves a turn before concurrent sends can pass model preparation", () =>
    Effect.gen(function* () {
      const harness = makeFakeHarness();
      const model = {
        provider: "openai",
        id: "test-model",
      } as NonNullable<NativePiSession["model"]>;
      let markFirstSelectionEntered: (() => void) | undefined;
      let releaseFirstSelection: (() => void) | undefined;
      const firstSelectionEntered = new Promise<void>((resolve) => {
        markFirstSelectionEntered = resolve;
      });
      const firstSelectionRelease = new Promise<void>((resolve) => {
        releaseFirstSelection = resolve;
      });
      harness.state.onSetModel = async () => {
        markFirstSelectionEntered?.();
        await firstSelectionRelease;
      };
      const sdk: NativePiSdk = {
        ...harness.sdk,
        resolveModel: () => ({ model }),
      };
      const adapter = yield* makeNativePiAdapter({
        instanceId: INSTANCE_ID,
        enabled: true,
        sdk,
      });
      const threadId = ThreadId.make("thread-concurrent-send");
      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
      const input = {
        threadId,
        input: "Continue",
        modelSelection: { instanceId: INSTANCE_ID, model: "openai/test-model" },
      } as const;

      const first = yield* adapter.sendTurn(input).pipe(Effect.forkChild);
      yield* Effect.promise(() => firstSelectionEntered);
      const second = yield* adapter.sendTurn(input).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      assert.strictEqual(harness.state.setModelCalls, 1);

      releaseFirstSelection?.();
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      assert.strictEqual(harness.state.setModelCalls, 1);
      assert.strictEqual(harness.state.promptCalls.length, 2);
    }),
  );

  it.effect("keeps auto mode supervised and never trusts colliding extension tool names", () =>
    Effect.gen(function* () {
      const harness = makeFakeHarness({ extensionToolNames: new Set(["read"]) });
      const adapter = yield* makeNativePiAdapter({
        instanceId: INSTANCE_ID,
        enabled: true,
        sdk: harness.sdk,
      });
      let opened = yield* Deferred.make<ProviderRuntimeEvent>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "request.opened" ? Deferred.succeed(opened, event) : Effect.void,
      ).pipe(Effect.forkChild);
      yield* Effect.yieldNow;

      const threadId = ThreadId.make("thread-auto-supervised");
      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "auto" });
      const authorize = harness.state.createInputs[0]?.authorizeTool;
      if (!authorize) return yield* Effect.die("Missing authorization callback");

      for (const toolName of ["bash", "read"]) {
        const authorization = yield* Effect.promise(() =>
          authorize({ toolCallId: `call-${toolName}`, toolName, args: {} }),
        ).pipe(Effect.forkChild);
        const request = yield* Deferred.await(opened);
        if (request.type !== "request.opened" || !request.requestId) {
          return yield* Effect.die("Missing approval request");
        }
        yield* adapter.respondToRequest(
          threadId,
          ApprovalRequestId.make(request.requestId),
          "decline",
        );
        assert.deepStrictEqual(yield* Fiber.join(authorization), {
          block: true,
          reason: "Declined by the user.",
        });
        opened = yield* Deferred.make<ProviderRuntimeEvent>();
      }
      yield* Fiber.interrupt(eventsFiber);
    }),
  );

  it.effect("rejects opening one Pi JSONL session in two T3 threads", () =>
    Effect.gen(function* () {
      const sharedPath = "/tmp/pi-shared-session.jsonl";
      const harness = makeFakeHarness({
        sessionFile: sharedPath,
        nativeSessions: [
          {
            id: "pi-shared",
            path: sharedPath,
            cwd: process.cwd(),
            created: DateTime.toDate(DateTime.makeUnsafe("2026-01-01T00:00:00.000Z")),
            modified: DateTime.toDate(DateTime.makeUnsafe("2026-01-01T00:00:00.000Z")),
            messageCount: 1,
            firstMessage: "Shared session",
            allMessagesText: "Shared session",
          },
        ],
      });
      const adapter = yield* makeNativePiAdapter({
        instanceId: INSTANCE_ID,
        enabled: true,
        sdk: harness.sdk,
      });
      const resumeCursor = { schemaVersion: 1, sessionId: "pi-shared" };
      yield* adapter.startSession({
        threadId: ThreadId.make("thread-resume-owner"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        resumeCursor,
      });
      const error = yield* adapter
        .startSession({
          threadId: ThreadId.make("thread-resume-conflict"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          resumeCursor,
        })
        .pipe(Effect.flip);

      assert.strictEqual(error._tag, "ProviderAdapterValidationError");
      assert.include(error.message, "already open");
      assert.strictEqual(harness.state.createInputs.length, 1);
    }),
  );

  it.effect("interrupts active turns and rolls back the initial turn", () =>
    Effect.gen(function* () {
      const interruptHarness = makeFakeHarness();
      let releasePrompt: (() => void) | undefined;
      interruptHarness.state.onPrompt = async () => {
        interruptHarness.state.isStreaming = true;
        await new Promise<void>((resolve) => {
          releasePrompt = resolve;
        });
      };
      interruptHarness.state.onAbort = async () => {
        interruptHarness.state.isStreaming = false;
        await interruptHarness.emit({ type: "agent_settled" });
        releasePrompt?.();
      };
      const interruptAdapter = yield* makeNativePiAdapter({
        instanceId: INSTANCE_ID,
        enabled: true,
        sdk: interruptHarness.sdk,
      });
      const aborted = yield* Deferred.make<void>();
      const interruptEvents: ProviderRuntimeEvent[] = [];
      const interruptFiber = yield* Stream.runForEach(interruptAdapter.streamEvents, (event) =>
        Effect.sync(() => interruptEvents.push(event)).pipe(
          Effect.andThen(
            event.type === "turn.aborted" ? Deferred.succeed(aborted, undefined) : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);
      yield* Effect.yieldNow;

      const interruptThreadId = ThreadId.make("thread-interrupt");
      yield* interruptAdapter.startSession({
        threadId: interruptThreadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const turn = yield* interruptAdapter.sendTurn({ threadId: interruptThreadId, input: "Stop" });
      yield* interruptAdapter.interruptTurn(interruptThreadId, turn.turnId);
      yield* Deferred.await(aborted);
      yield* Fiber.interrupt(interruptFiber);

      assert.strictEqual(interruptHarness.state.abortCalls, 1);
      assert.strictEqual(
        interruptEvents.filter((event) => event.type === "turn.completed").length,
        0,
      );

      const rollbackHarness = makeFakeHarness({ initialLeafId: null });
      rollbackHarness.state.onPrompt = async () => {
        await rollbackHarness.emit(entryAppended("entry-user", null));
        await rollbackHarness.emit(entryAppended("entry-assistant", "entry-user"));
        await rollbackHarness.emit({ type: "agent_settled" });
      };
      const rollbackAdapter = yield* makeNativePiAdapter({
        instanceId: INSTANCE_ID,
        enabled: true,
        sdk: rollbackHarness.sdk,
      });
      const completed = yield* Deferred.make<void>();
      const rollbackFiber = yield* Stream.runForEach(rollbackAdapter.streamEvents, (event) =>
        event.type === "turn.completed" ? Deferred.succeed(completed, undefined) : Effect.void,
      ).pipe(Effect.forkChild);
      yield* Effect.yieldNow;

      const rollbackThreadId = ThreadId.make("thread-rollback");
      yield* rollbackAdapter.startSession({
        threadId: rollbackThreadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* rollbackAdapter.sendTurn({ threadId: rollbackThreadId, input: "Undo me" });
      yield* Deferred.await(completed);
      const rolledBack = yield* rollbackAdapter.rollbackThread(rollbackThreadId, 1);
      yield* Fiber.interrupt(rollbackFiber);

      assert.strictEqual(rollbackHarness.state.resetCalls, 1);
      assert.strictEqual(rolledBack.turns.length, 0);
    }),
  );

  it.effect("steers a running Pi turn while keeping one active channel turn", () =>
    Effect.gen(function* () {
      const harness = makeFakeHarness();
      let releaseInitialPrompt: (() => void) | undefined;
      harness.state.onPrompt = async () => {
        if (harness.state.promptCalls.length === 1) {
          harness.state.isStreaming = true;
          await new Promise<void>((resolve) => {
            releaseInitialPrompt = resolve;
          });
          return;
        }
        harness.state.isStreaming = false;
        await harness.emit({ type: "agent_settled" });
        releaseInitialPrompt?.();
      };
      const adapter = yield* makeNativePiAdapter({
        instanceId: INSTANCE_ID,
        enabled: true,
        sdk: harness.sdk,
      });
      const observed: ProviderRuntimeEvent[] = [];
      const completed = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => observed.push(event)).pipe(
          Effect.andThen(
            event.type === "turn.completed" ? Deferred.succeed(completed, undefined) : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);
      yield* Effect.yieldNow;

      const threadId = ThreadId.make("thread-steer");
      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
      yield* adapter.sendTurn({ threadId, input: "Initial work" });
      yield* adapter.sendTurn({ threadId, input: "Change direction" });
      yield* Deferred.await(completed);
      yield* Fiber.interrupt(eventsFiber);

      assert.strictEqual(harness.state.promptCalls[1]?.[1]?.streamingBehavior, "steer");
      assert.strictEqual(observed.filter((event) => event.type === "turn.aborted").length, 1);
      assert.strictEqual(observed.filter((event) => event.type === "turn.completed").length, 1);
    }),
  );
});
