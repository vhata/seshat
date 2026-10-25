import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SignInPage } from "./App";

describe("sign-in presentation", () => {
  it("explains an ended session and offers sign-in", () => {
    const html = renderToStaticMarkup(<SignInPage session="ended" />);
    expect(html).toContain("Your session has ended. Sign in again to continue.");
    expect(html).toContain('role="status"');
    expect(html).toContain('href="/auth/sign-in"');
    expect(html).toContain("Sign in with GitHub");
    expect(html).not.toContain("Disconnected");
    expect(html).not.toContain("Loading your PR overview");
  });
});
