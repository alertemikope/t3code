import type { ProviderOptionSelection } from "@t3tools/contracts";
import { getProviderOptionStringSelectionValue } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { ChildProcess } from "effect/unstable/process";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpClient from "effect-acp/client";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

export interface GenericAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly spawn: AcpSessionRuntime.AcpSpawnInput;
}

/**
 * Build one ACP runtime around an arbitrary stdio agent command. Ocean and Pi
 * use the same protocol and differ only by command/configuration.
 */
export const makeGenericAcpRuntime = (
  input: GenericAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      AcpSessionRuntime.layer(input).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(Effect.provide(context));
  });

export const listGenericAcpSessions = Effect.fn("listGenericAcpSessions")(function* (input: {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly spawn: AcpSessionRuntime.AcpSpawnInput;
  readonly cwd?: string;
  readonly clientInfo: {
    readonly name: string;
    readonly version: string;
  };
}) {
  const scope = yield* Scope.Scope;
  const spawnCommand = yield* resolveSpawnCommand(
    input.spawn.command,
    input.spawn.args,
    input.spawn.env ? { env: input.spawn.env, extendEnv: true } : {},
  );
  const child = yield* input.childProcessSpawner
    .spawn(
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        ...(input.spawn.cwd ? { cwd: input.spawn.cwd } : {}),
        ...(input.spawn.env ? { env: input.spawn.env, extendEnv: true } : {}),
        shell: spawnCommand.shell,
      }),
    )
    .pipe(
      Effect.provideService(Scope.Scope, scope),
      Effect.mapError(
        (cause) =>
          new EffectAcpErrors.AcpSpawnError({
            command: input.spawn.command,
            cause,
          }),
      ),
    );
  const context = yield* Layer.build(EffectAcpClient.layerChildProcess(child)).pipe(
    Effect.provideService(Scope.Scope, scope),
  );
  const acp = yield* Effect.service(EffectAcpClient.AcpClient).pipe(Effect.provide(context));
  const initialized = yield* acp.agent.initialize({
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
    clientInfo: input.clientInfo,
  });
  if (initialized.agentCapabilities?.sessionCapabilities?.list === undefined) {
    return [];
  }

  const sessions: Array<EffectAcpSchema.SessionInfo> = [];
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  for (let page = 0; page < 100; page += 1) {
    const response = yield* acp.agent.listSessions({
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(cursor ? { cursor } : {}),
    });
    sessions.push(...response.sessions);
    const nextCursor = response.nextCursor?.trim();
    if (!nextCursor || seenCursors.has(nextCursor)) break;
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  return sessions;
});

function normalized(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_");
}

function selectValues(
  option: EffectAcpSchema.SessionConfigOption,
): ReadonlyArray<{ readonly value: string; readonly name: string }> {
  if (option.type !== "select") return [];
  return option.options.flatMap((entry) =>
    "value" in entry
      ? [{ value: entry.value, name: entry.name }]
      : entry.options.map((nested) => ({ value: nested.value, name: nested.name })),
  );
}

function findThoughtLevelOption(
  options: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): EffectAcpSchema.SessionConfigOption | undefined {
  return options.find((option) => {
    const tokens = [option.category, option.id, option.name].filter(
      (value): value is string => typeof value === "string",
    );
    return tokens.some((token) => {
      const value = normalized(token);
      return (
        value === "thought_level" ||
        value === "reasoning_effort" ||
        value === "reasoning" ||
        value === "thinking"
      );
    });
  });
}

export interface GenericAcpSelectionRuntime {
  readonly getConfigOptions: AcpSessionRuntime.AcpSessionRuntime["Service"]["getConfigOptions"];
  readonly setModel: AcpSessionRuntime.AcpSessionRuntime["Service"]["setModel"];
  readonly setConfigOption: AcpSessionRuntime.AcpSessionRuntime["Service"]["setConfigOption"];
}

/**
 * Apply T3's model + `reasoningEffort` selection to the semantic ACP options
 * advertised by both pi-acp and the Ocean bridge.
 */
export function applyGenericAcpModelSelection<E>(input: {
  readonly runtime: GenericAcpSelectionRuntime;
  readonly model: string | null | undefined;
  readonly selections: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  readonly mapError: (context: {
    readonly cause: EffectAcpErrors.AcpError;
    readonly configId: string;
  }) => E;
}): Effect.Effect<void, E> {
  return Effect.gen(function* () {
    const model = input.model?.trim();
    if (model && model !== "default") {
      yield* input.runtime.setModel(model).pipe(
        Effect.mapError((cause) =>
          input.mapError({
            cause,
            configId: "model",
          }),
        ),
      );
    }

    const requestedEffort = getProviderOptionStringSelectionValue(
      input.selections,
      "reasoningEffort",
    );
    if (!requestedEffort) return;

    const thoughtOption = findThoughtLevelOption(yield* input.runtime.getConfigOptions);
    if (!thoughtOption) return;
    const requested = normalized(requestedEffort);
    const matched = selectValues(thoughtOption).find(
      (candidate) =>
        normalized(candidate.value) === requested || normalized(candidate.name) === requested,
    );
    if (!matched) return;

    yield* input.runtime.setConfigOption(thoughtOption.id, matched.value).pipe(
      Effect.mapError((cause) =>
        input.mapError({
          cause,
          configId: thoughtOption.id,
        }),
      ),
      Effect.asVoid,
    );
  });
}
