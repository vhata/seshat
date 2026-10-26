import { useCallback, useEffect, useState } from "react";
import { Overview } from "./Overview";
import { Repositories } from "./Repositories";
import { watchSessionExpiry, type SessionExpiry } from "./session-expiry";
import logo from "../../assets/seshat.svg";
import "./styles.css";

type Session = "checking" | "signed-out" | "signed-in" | "failed" | "ended";
export function App() {
  const [session, setSession] = useState<Session>("checking");
  const [expiry, setExpiry] = useState<SessionExpiry | null>(null);
  const onSessionEnded = useCallback(() => setSession("ended"), []);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/session", { signal: controller.signal })
      .then(async (response) => {
        if (controller.signal.aborted) return;
        if (response.status === 401) setSession("signed-out");
        else if (response.ok) {
          const body = (await response.json()) as {
            expiresAt?: unknown;
            serverTime?: unknown;
          };
          if (controller.signal.aborted) return;
          if (
            typeof body.expiresAt !== "number" ||
            !Number.isFinite(body.expiresAt)
          ) {
            setSession("failed");
            return;
          }
          setExpiry({
            expiresAt: body.expiresAt,
            serverTime: typeof body.serverTime === "number" && Number.isFinite(body.serverTime)
              ? body.serverTime : undefined,
          });
          setSession("signed-in");
        } else setSession("failed");
      })
      .catch(() => {
        if (!controller.signal.aborted) setSession("failed");
      });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (session === "signed-in" && expiry !== null)
      return watchSessionExpiry(expiry, onSessionEnded);
  }, [session, expiry, onSessionEnded]);
  if (session === "signed-in") {
    return window.location.pathname === "/repositories" ? (
      <Repositories />
    ) : (
      <Overview onSessionEnded={onSessionEnded} />
    );
  }
  return <SignInPage session={session} />;
}
export function SignInPage({
  session,
}: {
  session: Exclude<Session, "signed-in">;
}) {
  return (
    <main className="sign-in">
      <img src={logo} alt="" />
      <h1>Seshat</h1>
      <p>Private instance</p>
      {session === "signed-out" || session === "ended" ? (
        <>
          {session === "ended" && (
            <p role="status">
              Your session has ended. Sign in again to continue.
            </p>
          )}
          <a className="sign-in-button" href="/auth/sign-in">
            Sign in with GitHub
          </a>
          <p>Only the owner of this instance can sign in.</p>
        </>
      ) : (
        <p role="status">
          {session === "checking"
            ? "Checking your session…"
            : "Could not reach the instance. Reload to try again."}
        </p>
      )}
    </main>
  );
}
