import { PiSettings, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import { makeUnsupportedTextGeneration } from "../../textGeneration/UnsupportedTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeGenericAcpAdapter } from "../Layers/GenericAcpAdapter.ts";
import {
  buildGenericAcpProviderSnapshot,
  makeStaticServerProvider,
} from "../Layers/GenericAcpProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import {
  makeManualOnlyProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);
const DRIVER_KIND = ProviderDriverKind.make("piAgent");
const DEFINITION = {
  displayName: "Pi",
  badgeLabel: "ACP",
  readyMessage: "Pi ACP is configured and uses your existing Pi credentials and extensions.",
  disabledMessage: "Pi is disabled for this provider instance.",
  builtInModels: [
    { slug: "openai-codex/gpt-5.6-sol", name: "GPT-5.6 Sol" },
    { slug: "openai-codex/gpt-5.6-terra", name: "GPT-5.6 Terra" },
    { slug: "openai-codex/gpt-5.6-luna", name: "GPT-5.6 Luna" },
  ],
} as const;

export type PiDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig;

function maintenanceCapabilities(): ProviderMaintenanceCapabilities {
  return makeManualOnlyProviderMaintenanceCapabilities({
    provider: DRIVER_KIND,
    packageName: "pi-acp",
  });
}

export const PiDriver: ProviderDriver<PiSettings, PiDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Pi",
    supportsMultipleInstances: true,
  },
  configSchema: PiSettings,
  defaultConfig: (): PiSettings => decodePiSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const eventLoggers = yield* ProviderEventLoggers;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const effectiveConfig = { ...config, enabled } satisfies PiSettings;
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const adapter = yield* makeGenericAcpAdapter(
        {
          enabled: effectiveConfig.enabled,
          command: effectiveConfig.binaryPath,
          args: tokenizeCliArgs(effectiveConfig.launchArgs),
        },
        {
          provider: DRIVER_KIND,
          instanceId,
          environment: processEnv,
          readyReason: "Pi session ready",
          ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        },
      );
      const draft = yield* buildGenericAcpProviderSnapshot({
        definition: DEFINITION,
        enabled: effectiveConfig.enabled,
        customModels: effectiveConfig.customModels,
      });
      const snapshotValue: ServerProvider = {
        ...draft,
        instanceId,
        driver: DRIVER_KIND,
        ...(displayName ? { displayName } : {}),
        ...(accentColor ? { accentColor } : {}),
        continuation: { groupKey: continuationIdentity.continuationKey },
      };
      const snapshot = makeStaticServerProvider({
        snapshot: snapshotValue,
        maintenanceCapabilities: maintenanceCapabilities(),
      });

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration: makeUnsupportedTextGeneration("Pi"),
      } satisfies ProviderInstance;
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: `Failed to build Pi provider: ${String(cause)}`,
            cause,
          }),
      ),
    ),
};
