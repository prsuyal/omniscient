import { Suspense } from "react";
import { redirect } from "next/navigation";

import { AuthenticatedAppShell } from "~/components/layout/AuthenticatedAppShell";
import { PipelineDashboardPage } from "~/components/dashboard/PipelineDashboardPage";
import { getServerAuthSession } from "~/server/auth";

export default async function DashboardPage() {
  const session = await getServerAuthSession();

  if (!session?.user) {
    redirect("/auth/sign-in?callbackUrl=/dashboard");
  }

  return (
    <AuthenticatedAppShell
      activePage="dashboard"
      title="Health Forecast Dashboard"
      subtitle="Monitor simulation outputs, compare modifier scenarios, and iterate with new freeform updates."
      user={session.user}
    >
      <Suspense
        fallback={
          <section className="app-panel app-panel-padded text-sm text-white/80">
            Loading dashboard...
          </section>
        }
      >
        <PipelineDashboardPage />
      </Suspense>
    </AuthenticatedAppShell>
  );
}
