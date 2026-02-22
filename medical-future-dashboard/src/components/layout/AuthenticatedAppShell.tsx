import Link from "next/link";

import { SignOutButton } from "~/components/auth/SignOutButton";

type ShellUser = {
  name?: string | null;
  email?: string | null;
};

type AuthenticatedAppShellProps = {
  activePage: "app" | "dashboard";
  children: React.ReactNode;
  subtitle: string;
  title: string;
  user: ShellUser;
};

const getNavClass = (isActive: boolean) =>
  isActive ? "ui-nav-link ui-nav-link-active" : "ui-nav-link";

export function AuthenticatedAppShell({
  activePage,
  children,
  subtitle,
  title,
  user,
}: AuthenticatedAppShellProps) {
  const userLabel = user.name ?? user.email ?? "Signed in user";

  return (
    <main className="app-main">
      <header className="app-shell app-panel app-panel-padded">
        <div className="app-shell-header">
          <div className="app-shell-title-wrap">
            <p className="app-eyebrow">Omniscient</p>
            <h1 className="app-title">{title}</h1>
            <p className="app-subtitle">{subtitle}</p>
          </div>

          <div className="app-user-wrap">
            <span className="app-user-label">{userLabel}</span>
            <SignOutButton />
          </div>
        </div>

        <nav className="app-nav" aria-label="Primary">
          <Link href="/app" className={getNavClass(activePage === "app")}>
            Data Input
          </Link>
          <Link
            href="/dashboard"
            className={getNavClass(activePage === "dashboard")}
          >
            Dashboard
          </Link>
        </nav>
      </header>

      <section className="app-shell app-content">{children}</section>
    </main>
  );
}
