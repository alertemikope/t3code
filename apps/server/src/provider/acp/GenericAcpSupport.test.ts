import { assert, it } from "@effect/vitest";
import { ProviderOptionSelection } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import { vi } from "vite-plus/test";

import {
  applyGenericAcpModelSelection,
  type GenericAcpSelectionRuntime,
} from "./GenericAcpSupport.ts";

it.effect("maps T3 model and reasoning effort onto semantic ACP config", () =>
  Effect.gen(function* () {
    const configOptions = [
      {
        type: "select",
        id: "model",
        name: "Model",
        category: "model",
        currentValue: "gpt-5.6-sol",
        options: [{ value: "gpt-5.6-sol", name: "Sol" }],
      },
      {
        type: "select",
        id: "thought_level",
        name: "Thinking",
        category: "thought_level",
        currentValue: "high",
        options: [
          { value: "high", name: "High" },
          { value: "xhigh", name: "XHigh" },
        ],
      },
    ] satisfies ReadonlyArray<EffectAcpSchema.SessionConfigOption>;
    const setModel = vi.fn((_model: string) => Effect.void);
    const setConfigOption = vi.fn((_configId: string, _value: string | boolean) =>
      Effect.succeed({ configOptions }),
    );
    const runtime = {
      getConfigOptions: Effect.succeed(configOptions),
      setModel,
      setConfigOption,
    } as GenericAcpSelectionRuntime;

    yield* applyGenericAcpModelSelection({
      runtime,
      model: "gpt-5.6-sol",
      selections: [ProviderOptionSelection.make({ id: "reasoningEffort", value: "xhigh" })],
      mapError: ({ cause }: { readonly cause: EffectAcpErrors.AcpError }) => cause,
    });

    assert.deepEqual(setModel.mock.calls, [["gpt-5.6-sol"]]);
    assert.deepEqual(setConfigOption.mock.calls, [["thought_level", "xhigh"]]);
  }),
);
