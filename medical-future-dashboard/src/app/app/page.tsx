import { redirect } from "next/navigation";

import { DataInputWorkspace } from "~/components/app/DataInputWorkspace";
import { AuthenticatedAppShell } from "~/components/layout/AuthenticatedAppShell";
import { getServerAuthSession } from "~/server/auth";

export default async function AppPage() {
  const session = await getServerAuthSession();

  if (!session?.user) {
    redirect("/auth/sign-in?callbackUrl=/app");
  }

  return (
    <AuthenticatedAppShell
      activePage="app"
      title="Data Intake Workspace"
      subtitle="Create and queue baseline simulations from structured fields or freeform uploads."
      user={session.user}
    >
      <DataInputWorkspace />
    </AuthenticatedAppShell>
  );
}
