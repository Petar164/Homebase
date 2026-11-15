import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only this project's own tests. /private, /repos and /home-base hold
    // reference material that is not part of the project.
    include: ["apps/*/test/**/*.test.ts", "packages/*/test/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
