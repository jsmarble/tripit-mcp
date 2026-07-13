import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // Test stand-ins for the deployment's registered TripIt app secrets.
        bindings: {
          TRIPIT_CONSUMER_KEY: "server-ck",
          TRIPIT_CONSUMER_SECRET: "server-cs",
        },
      },
    }),
  ],
  test: {
    setupFiles: ["test/setup.ts"],
  },
});
