import { useEffect, useState } from "react";
import { isHealthResponse, type HealthResponse } from "../shared/health";

type Session =
  | { state: "checking" }
  | { state: "signed-out" }
  | { state: "signed-in" }
  | { state: "failed"; reason: string };

type Status =
  | { state: "checking" }
  | { state: "ok"; health: HealthResponse }
  | { state: "failed"; reason: string };

export function App() {
  const [session, setSession] = useState<Session>({ state: "checking" });

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/session", { signal: controller.signal })
      .then((response) => {
        if (response.status === 401) setSession({ state: "signed-out" });
        else if (response.ok) setSession({ state: "signed-in" });
        else throw new Error(`unexpected response (HTTP ${response.status})`);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setSession({ state: "failed", reason: String(error) });
      });
    return () => controller.abort();
  }, []);

  if (session.state === "signed-out") return <SignIn />;
  return (
    <main>
      <h1>Seshat</h1>
      {session.state === "checking" && <p role="status">Checking your session...</p>}
      {session.state === "failed" && (
        <p role="status">Could not check your session: {session.reason}</p>
      )}
      {session.state === "signed-in" && <Overview />}
    </main>
  );
}

/** Shown to anyone without the owner's session; it holds no instance data. */
function SignIn() {
  return (
    <main>
      <h1>Seshat</h1>
      <p>Private instance</p>
      <p>
        <a href="/auth/sign-in">Sign in with GitHub</a>
      </p>
      <p>Only the owner of this instance can sign in.</p>
    </main>
  );
}

function Overview() {
  const [status, setStatus] = useState<Status>({ state: "checking" });

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/health", { signal: controller.signal })
      .then(async (response) => {
        const body: unknown = await response.json();
        if (!response.ok || !isHealthResponse(body)) {
          throw new Error(`unexpected response (HTTP ${response.status})`);
        }
        setStatus({ state: "ok", health: body });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setStatus({ state: "failed", reason: String(error) });
      });
    return () => controller.abort();
  }, []);

  return (
    <>
      <p>The PR overview is not built yet.</p>
      <p role="status">
        {status.state === "checking" && "Checking the instance..."}
        {status.state === "ok" &&
          `Instance reachable, schema version ${status.health.schemaVersion}.`}
        {status.state === "failed" && `Instance check failed: ${status.reason}`}
      </p>
      <p>
        <a href="/setup/installed">Check the GitHub App installation</a>
      </p>
      <form method="post" action="/auth/sign-out">
        <button type="submit">Sign out</button>
      </form>
    </>
  );
}
