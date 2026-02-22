"use client";

import { signOut } from "next-auth/react";
import { useTransition } from "react";

export function SignOutButton() {
  const [isPending, startTransition] = useTransition();

  return (
    <button
      type="button"
      onClick={() => {
        startTransition(() => {
          void signOut({ callbackUrl: "/" });
        });
      }}
      className="ui-btn ui-btn-subtle"
      disabled={isPending}
    >
      {isPending ? "Signing Out..." : "Sign Out"}
    </button>
  );
}
