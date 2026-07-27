import { TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type * as TextGeneration from "./TextGeneration.ts";

export function makeUnsupportedTextGeneration(
  providerName: string,
): TextGeneration.TextGeneration["Service"] {
  const unsupported = <A>(operation: string): Effect.Effect<A, TextGenerationError> =>
    Effect.fail(
      new TextGenerationError({
        operation,
        detail: `${providerName} supports interactive sessions but is not used for T3 metadata generation.`,
      }),
    );

  return {
    generateCommitMessage: () => unsupported("generateCommitMessage"),
    generatePrContent: () => unsupported("generatePrContent"),
    generateBranchName: () => unsupported("generateBranchName"),
    generateThreadTitle: () => unsupported("generateThreadTitle"),
  };
}
