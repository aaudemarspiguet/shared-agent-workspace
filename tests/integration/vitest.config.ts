// Integration tests drive real daemons against a real relay.
// They need more time than unit tests.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 20000,
    hookTimeout: 20000
  }
});
