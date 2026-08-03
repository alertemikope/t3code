import { ChannelId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { ChannelsView } from "../components/channels/ChannelsView";

function ChannelRouteView() {
  const channelId = Route.useParams({ select: (params) => ChannelId.make(params.channelId) });
  return <ChannelsView selectedChannelId={channelId} />;
}

export const Route = createFileRoute("/_chat/channels/$channelId")({
  component: ChannelRouteView,
});
