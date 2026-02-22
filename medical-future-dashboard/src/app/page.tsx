import { redirect } from "next/navigation";

import { LandingScrollExperience } from "~/components/landing/LandingScrollExperience";
import { getServerAuthSession } from "~/server/auth";

export default async function LandingPage() {
  const session = await getServerAuthSession();

  if (session?.user) {
    redirect("/app");
  }

  return <LandingScrollExperience />;
}
