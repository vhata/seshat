import { useEffect, useState } from "react";
import { Overview } from "./Overview";
import { Repositories } from "./Repositories";
import logo from "../../assets/seshat.svg";
import "./styles.css";

type Session = "checking" | "signed-out" | "signed-in" | "failed";
export function App() {
  const [session, setSession] = useState<Session>("checking");
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/session", { signal: controller.signal })
      .then((response) => {
        if (response.status === 401) setSession("signed-out");
        else if (response.ok) setSession("signed-in");
        else setSession("failed");
      })
      .catch(() => {
        if (!controller.signal.aborted) setSession("failed");
      });
    return () => controller.abort();
  }, []);
  if (session === "signed-in") {
    return window.location.pathname === "/repositories" ? (
      <Repositories />
    ) : (
      <Overview />
    );
  }
  return (
    <main className="sign-in">
      <img src={logo} alt="" />
      <h1>Seshat</h1>
      <p>Private instance</p>
      {session === "signed-out" ? (
        <>
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
