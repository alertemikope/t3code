import {
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import {
  buildSelectOptionDescriptor,
  buildServerProvider,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import type { ProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import type { ServerProviderShape } from "../Services/ServerProvider.ts";

const THINKING_OPTIONS = [
  { value: "off", label: "Off" },
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High", isDefault: true },
  { value: "xhigh", label: "Extra high" },
] as const;

export const GENERIC_ACP_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    buildSelectOptionDescriptor({
      id: "reasoningEffort",
      label: "Thinking",
      description: "Reasoning effort applied to this Ocean or Pi session.",
      options: THINKING_OPTIONS,
    }),
  ],
});

export interface GenericAcpProviderDefinition {
  readonly displayName: string;
  readonly badgeLabel: string;
  readonly readyMessage: string;
  readonly disabledMessage: string;
  readonly builtInModels: ReadonlyArray<{
    readonly slug: string;
    readonly name: string;
  }>;
}

export function buildGenericAcpModels(
  definition: GenericAcpProviderDefinition,
  customModels: ReadonlyArray<string>,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    definition.builtInModels.map((model) => ({
      ...model,
      isCustom: false,
      capabilities: GENERIC_ACP_MODEL_CAPABILITIES,
    })),
    customModels,
    GENERIC_ACP_MODEL_CAPABILITIES,
  );
}

export function buildGenericAcpProviderSnapshot(input: {
  readonly definition: GenericAcpProviderDefinition;
  readonly enabled: boolean;
  readonly customModels: ReadonlyArray<string>;
}): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    return buildServerProvider({
      presentation: {
        displayName: input.definition.displayName,
        badgeLabel: input.definition.badgeLabel,
        showInteractionModeToggle: false,
        requiresNewThreadForModelChange: false,
      },
      enabled: input.enabled,
      checkedAt,
      models: buildGenericAcpModels(input.definition, input.customModels),
      probe: {
        installed: input.enabled,
        version: null,
        status: input.enabled ? "ready" : "warning",
        auth: { status: "unknown" },
        message: input.enabled ? input.definition.readyMessage : input.definition.disabledMessage,
      },
    });
  });
}

export function makeStaticServerProvider(input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
}): ServerProviderShape {
  return {
    maintenanceCapabilities: input.maintenanceCapabilities,
    getSnapshot: Effect.succeed(input.snapshot),
    refresh: Effect.succeed(input.snapshot),
    streamChanges: Stream.empty,
  };
}
