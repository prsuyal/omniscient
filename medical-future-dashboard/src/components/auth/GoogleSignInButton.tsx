"use client";

import { signIn } from "next-auth/react";
import { useTransition } from "react";

export function GoogleSignInButton({ callbackUrl }: { callbackUrl: string }) {
  const [isPending, startTransition] = useTransition();

  return (
    <button
      type="button"
      onClick={() => {
        startTransition(() => {
          void signIn("google", { callbackUrl });
        });
      }}
      className="ui-btn ui-btn-primary"
      disabled={isPending}
    >
      {isPending ? "Redirecting..." : "Continue With Google"}
    </button>
  );
}
