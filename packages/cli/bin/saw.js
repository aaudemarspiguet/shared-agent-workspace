#!/usr/bin/env node
// The saw command entry point.
// The monorepo ships TypeScript source with no build step.
// This shim loads tsx first, then runs the TypeScript CLI directly.
import { register } from "tsx/esm/api";

register();
await import("../src/cli.ts");
