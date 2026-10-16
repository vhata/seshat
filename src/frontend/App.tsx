import { useEffect, useState } from "react";
import { isHealthResponse, type HealthResponse } from "../shared/health";

type Status =
  | { state: "checking" }
  | { state: "ok"; health: HealthResponse }
  | { state: "failed"; reason: string };

export function App() {
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
    <main>
      <h1>Seshat</h1>
      <p>The PR overview is not built yet.</p>
      <p role="status">
        {status.state === "checking" && "Checking the instance..."}
        {status.state === "ok" &&
          `Instance reachable, schema version ${status.health.schemaVersion}.`}
        {status.state === "failed" && `Instance check failed: ${status.reason}`}
      </p>
    </main>
  );
}
