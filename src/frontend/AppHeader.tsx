import type { ReactNode } from "react";
import logo from "../../assets/seshat.svg";

export function AppHeader({
  page,
  children,
}: {
  page: "overview" | "repositories";
  children?: ReactNode;
}) {
  return (
    <header className="app-header">
      <a className="brand" href="/">
        <img src={logo} alt="" />
        Seshat
      </a>
      <nav aria-label="Main">
        <a href="/" aria-current={page === "overview" ? "page" : undefined}>
          Overview
        </a>
        <a
          href="/repositories"
          aria-current={page === "repositories" ? "page" : undefined}
        >
          Repositories
        </a>
      </nav>
      {children}
      <form method="post" action="/auth/sign-out">
        <button className="quiet" type="submit">
          Sign out
        </button>
      </form>
    </header>
  );
}
