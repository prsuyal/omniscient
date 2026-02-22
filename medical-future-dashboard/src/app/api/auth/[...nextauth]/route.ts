import NextAuth from "next-auth/next";

import { authOptions } from "~/server/auth";

// NextAuth's route handler type is currently surfaced as any in this import path.
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const handler = NextAuth(authOptions);

export { handler as GET, handler as POST };
