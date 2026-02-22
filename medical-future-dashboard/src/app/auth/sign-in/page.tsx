import Link from "next/link";
import { redirect } from "next/navigation";

import { GoogleSignInButton } from "~/components/auth/GoogleSignInButton";
import { getServerAuthSession } from "~/server/auth";

type SignInPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

const sanitizeCallbackUrl = (value: string | string[] | undefined): string => {
  const firstValue = Array.isArray(value) ? value[0] : value;

  if (!firstValue?.startsWith("/")) {
    return "/app";
  }

  return firstValue;
};

export default async function SignInPage({ searchParams }: SignInPageProps) {
  const session = await getServerAuthSession();
  const resolvedParams = (await searchParams) ?? {};
  const callbackUrl = sanitizeCallbackUrl(resolvedParams.callbackUrl);

  if (session?.user) {
    redirect(callbackUrl);
  }

  return (
    <main className="app-main">
      <section className="app-shell app-panel app-panel-padded">
        <p className="app-eyebrow">Omniscient</p>
        <h1 className="app-title">Sign In Or Sign Up</h1>
        <p className="app-subtitle max-w-2xl">
          Use Google OAuth to access your private simulation workspace. First-time
          sign-in automatically creates your account.
        </p>

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <GoogleSignInButton callbackUrl={callbackUrl} />
          <Link href="/" className="ui-btn ui-btn-subtle">
            Back To Home
          </Link>
        </div>
      </section>
    </main>
  );
}
