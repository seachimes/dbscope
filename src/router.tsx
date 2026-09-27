import { createRootRoute, createRoute, createRouter, redirect } from "@tanstack/react-router";
import { AppShell } from "./App.tsx";

const rootRoute = createRootRoute({ component: AppShell });

const connectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
});

const overviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/overview",
});

const tableRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tables/$table",
});

const queriesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/queries",
});

const explainRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/explain",
  validateSearch: (search: Record<string, unknown>) => ({
    // SQL is optional. Links generated inside DBSCOPE use it for navigation and
    // reloadability; users should avoid sharing URLs containing sensitive data.
    sql: typeof search.sql === "string" ? search.sql : undefined,
  }),
});

const notFoundRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "$",
  beforeLoad: () => {
    throw redirect({ to: "/overview" });
  },
});

const routeTree = rootRoute.addChildren([
  connectRoute,
  overviewRoute,
  tableRoute,
  queriesRoute,
  explainRoute,
  notFoundRoute,
]);

export const router = createRouter({ routeTree, defaultPreload: "intent" });

export type AppRouter = typeof router;
declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
