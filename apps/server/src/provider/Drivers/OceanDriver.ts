import { OceanSettings, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
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
  makeProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";

const decodeOceanSettings = Schema.decodeSync(OceanSettings);
const DRIVER_KIND = ProviderDriverKind.make("ocean");
const DEFINITION = {
  displayName: "Ocean",
  badgeLabel: "Local",
  readyMessage: "Ocean ACP is configured. Sessions use the connected Ocean daemon.",
  disabledMessage: "Ocean is disabled for this provider instance.",
  builtInModels: [
    { slug: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
    { slug: "gpt-5.6-terra", name: "GPT-5.6 Terra" },
    { slug: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
  ],
} as const;

export type OceanDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig;

function maintenanceCapabilities(binaryPath: string): ProviderMaintenanceCapabilities {
  return makeProviderMaintenanceCapabilities({
    provider: DRIVER_KIND,
    packageName: null,
    updateExecutable: binaryPath === "ocean-acp" ? "ocean-update" : null,
    updateArgs: [],
    updateLockKey: binaryPath === "ocean-acp" ? "ocean-stack" : null,
  });
}

export const OceanDriver: ProviderDriver<OceanSettings, OceanDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Ocean",
    supportsMultipleInstances: true,
  },
  configSchema: OceanSettings,
  defaultConfig: (): OceanSettings => decodeOceanSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const eventLoggers = yield* ProviderEventLoggers;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const effectiveConfig = { ...config, enabled } satisfies OceanSettings;
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const adapter = yield* makeGenericAcpAdapter(
        {
          enabled: effectiveConfig.enabled,
          command: effectiveConfig.binaryPath,
          args: [
            "--daemon-url",
            effectiveConfig.daemonUrl,
            ...tokenizeCliArgs(effectiveConfig.launchArgs),
          ],
        },
        {
          provider: DRIVER_KIND,
          instanceId,
          environment: processEnv,
          readyReason: "Ocean session ready",
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
        maintenanceCapabilities: maintenanceCapabilities(effectiveConfig.binaryPath),
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
        textGeneration: makeUnsupportedTextGeneration("Ocean"),
      } satisfies ProviderInstance;
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: `Failed to build Ocean provider: ${String(cause)}`,
            cause,
          }),
      ),
    ),
};
