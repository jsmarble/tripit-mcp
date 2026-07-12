import { afterAll, afterEach, beforeAll } from "vitest";
import { server } from "./server";

// Fail any test that lets an unmocked request leave the Worker — the suite
// must never hit the real TripIt API.
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
