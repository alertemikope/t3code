import { Outlet, createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_chat/channels")({
  component: Outlet,
});
