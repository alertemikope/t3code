import { ModelRuntime, VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { PiSettings, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../../config.ts";
import { makeUnsupportedTextGeneration } from "../../textGeneration/UnsupportedTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import {
  buildGenericAcpProviderSnapshot,
  makeStaticServerProvider,
} from "../Layers/GenericAcpProvider.ts";
import { makeNativePiAdapter } from "../Layers/NativePiAdapter.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import {
  makeManualOnlyProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);
const DRIVER_KIND = ProviderDriverKind.make("piAgent");
export type PiDriverEnv = Crypto.Crypto | FileSystem.FileSystem | Path.Path | ServerConfig;

function maintenanceCapabilities(): ProviderMaintenanceCapabilities {
  return makeManualOnlyProviderMaintenanceCapabilities({
    provider: DRIVER_KIND,
    packageName: "@earendil-works/pi-coding-agent",
  });
}

export const PiDriver: ProviderDriver<PiSettings, PiDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Pi",
    supportsMultipleInstances: false,
  },
  configSchema: PiSettings,
  defaultConfig: (): PiSettings => decodePiSettings({}),
  create: ({ instanceId, displayName, accentColor, enabled, config }) =>
    Effect.gen(function* () {
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const modelRuntime = yield* Effect.tryPromise({
        try: async () => {
          return ModelRuntime.create();
        },
        catch: (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: "Failed to read models from the embedded Pi runtime.",
            cause,
          }),
      });
      const availableModels = yield* Effect.tryPromise({
        try: () => modelRuntime.getAvailable(),
        catch: (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: "Failed to read models from the embedded Pi runtime.",
            cause,
          }),
      });
      const builtInModels = availableModels.map((model) => ({
        slug: `${model.provider}/${model.id}`,
        name: model.name || model.id,
      }));
      const adapter = yield* makeNativePiAdapter({ instanceId, enabled, modelRuntime });
      const draft = yield* buildGenericAcpProviderSnapshot({
        definition: {
          displayName: "Pi",
          badgeLabel: "SDK",
          readyMessage: `Pi ${PI_VERSION} runs natively inside T3 and reuses your existing credentials, extensions, skills and sessions.`,
          disabledMessage: "Native Pi is disabled for this provider instance.",
          builtInModels,
        },
        enabled,
        customModels: config.customModels,
      });
      const snapshotValue: ServerProvider = {
        ...draft,
        version: PI_VERSION,
        instanceId,
        driver: DRIVER_KIND,
        ...(displayName ? { displayName } : {}),
        ...(accentColor ? { accentColor } : {}),
        continuation: { groupKey: continuationIdentity.continuationKey },
      };

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot: makeStaticServerProvider({
          snapshot: snapshotValue,
          maintenanceCapabilities: maintenanceCapabilities(),
        }),
        adapter,
        textGeneration: makeUnsupportedTextGeneration("Pi"),
      } satisfies ProviderInstance;
    }).pipe(
      Effect.mapError((cause) =>
        Schema.is(ProviderDriverError)(cause)
          ? cause
          : new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build native Pi provider: ${String(cause)}`,
              cause,
            }),
      ),
    ),
};
