/**
 * Vitest setup for every test project: no test may reach the network.
 *
 * Before each test `fetch` is replaced with a guard that records the
 * request and throws. A test that expects requests installs its own stub
 * (see `stubGitHub`), and anything that stub does not answer is recorded the
 * same way. After each test any recorded request fails it, even when the
 * code under test caught the error and carried on.
 */

import { afterEach, beforeEach, expect, vi } from "vitest";

const unexpected: string[] = [];

/** Records a request no stub answers and throws, so it is never sent. */
export function refuseRequest(method: string, url: string): never {
  const description = `${method} ${url}`;
  unexpected.push(description);
  throw new Error(`unexpected network request in a test: ${description}`);
}

beforeEach(() => {
  unexpected.length = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    return refuseRequest(request.method, request.url);
  });
});

afterEach(() => {
  const found = unexpected.splice(0);
  expect(found, "network requests that no stub answered").toEqual([]);
});
