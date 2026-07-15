import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  oxc: {
    jsx: {
      runtime: "automatic",
      importSource: "react"
    }
  },
  test: {
    environment: "node",
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"]
  },
  resolve: {
    alias: {
      "@eim/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
      "@eim/db": fileURLToPath(new URL("./packages/db/src/index.ts", import.meta.url)),
      "@eim/worker": fileURLToPath(new URL("./packages/worker/src/index.ts", import.meta.url))
    }
  }
});
