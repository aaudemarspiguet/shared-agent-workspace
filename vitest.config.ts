// Vitest finds each package's tests through the projects list.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/*", "tests/*"]
  }
});
