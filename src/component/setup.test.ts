/// <reference types="vite/client" />

import { test } from "vitest";

export const modules = import.meta.glob("./**/*.*s");

test("setup", () => {});

const patchedRuntimes = new WeakSet<object>();

// This adapter tests behavior only; the native backend tests snapshot isolation and OCC.
export function enableSnapshotQueries() {
  const runtime = (globalThis as unknown as { Convex: object }).Convex;
  if (patchedRuntimes.has(runtime)) return;
  const descriptor = Object.getOwnPropertyDescriptor(runtime, "asyncSyscall");
  if (!descriptor?.get) throw new Error("Unexpected convex-test runtime");
  Object.defineProperty(runtime, "asyncSyscall", {
    configurable: true,
    get() {
      const original = descriptor.get!.call(runtime) as (
        op: string,
        args: string,
      ) => Promise<string>;
      return (op: string, json: string) => {
        if (op === "1.0/runUdf") {
          const args = JSON.parse(json) as { udfType?: string };
          if (args.udfType === "snapshotQuery") {
            args.udfType = "query";
            return original(op, JSON.stringify(args));
          }
        }
        return original(op, json);
      };
    },
  });
  patchedRuntimes.add(runtime);
}
