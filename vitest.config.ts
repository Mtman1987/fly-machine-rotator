import { defineConfig } from "vitest/config";

export default defineConfig({
  // Pure mobile helpers are also tested by backend CI, without installing Expo.
  esbuild: { tsconfigRaw: JSON.stringify({ compilerOptions: { target: "ES2022", useDefineForClassFields: true } }) },
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**", "targets/**"]
  }
});
