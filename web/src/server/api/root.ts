import { createTRPCRouter } from "~/server/api/trpc";
import { simulationRouter } from "~/server/api/routers/simulation";

export const appRouter = createTRPCRouter({
  simulation: simulationRouter,
});

export type AppRouter = typeof appRouter;
