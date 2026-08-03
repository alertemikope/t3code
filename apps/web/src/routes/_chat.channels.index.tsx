import { createFileRoute } from "@tanstack/react-router";

import { ChannelsView } from "../components/channels/ChannelsView";

export const Route = createFileRoute("/_chat/channels/")({
  component: () => <ChannelsView selectedChannelId={null} />,
});
