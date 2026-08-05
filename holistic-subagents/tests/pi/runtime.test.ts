import { describe, expect, it, vi } from "vitest";

import { createInfrastructureEventHandler } from "../../src/pi/runtime.ts";

const event = {
  event: "pane.agent_status_changed",
  data: { pane_id: "p1", agent_status: "idle" },
};

function fixture() {
  const onInfrastructureEvent = vi.fn();
  const connect = vi.fn();
  const notify = vi.fn();
  const onChange = vi.fn();
  return {
    service: { onInfrastructureEvent },
    client: { connect },
    ctx: { ui: { notify } },
    onChange,
  };
}

describe("infrastructure event runtime adapter", () => {
  it("notifies rejected events without connecting or mutating runtime state", async () => {
    const fx = fixture();
    fx.service.onInfrastructureEvent.mockRejectedValueOnce(new Error("stale runtime status"));
    const handleEvent = createInfrastructureEventHandler(
      fx.service,
      fx.ctx,
      fx.onChange,
    );

    await handleEvent(event);

    expect(fx.ctx.ui.notify).toHaveBeenNthCalledWith(
      1,
      "Holistic infrastructure event rejected: stale runtime status",
      "error",
    );
    expect(fx.client.connect).not.toHaveBeenCalled();
    expect(fx.onChange).not.toHaveBeenCalled();
  });

  it("processes later subscription events after a rejection", async () => {
    const fx = fixture();
    fx.service.onInfrastructureEvent
      .mockRejectedValueOnce(new Error("stale runtime status"))
      .mockResolvedValueOnce(undefined);
    const handleEvent = createInfrastructureEventHandler(fx.service, fx.ctx, fx.onChange);

    await handleEvent(event);
    await handleEvent({ ...event, data: { ...event.data, agent_status: "working" } });

    expect(fx.service.onInfrastructureEvent).toHaveBeenCalledTimes(2);
    expect(fx.service.onInfrastructureEvent).toHaveBeenNthCalledWith(2, {
      ...event,
      data: { ...event.data, agent_status: "working" },
    });
    expect(fx.client.connect).not.toHaveBeenCalled();
    expect(fx.onChange).toHaveBeenCalledOnce();
    expect(fx.ctx.ui.notify).toHaveBeenCalledOnce();
  });
});
