import { afterEach, describe, expect, it, vi } from "vitest";
import { newTopic, publicTopic, subscribeLink, topicUrl } from "./topic";

afterEach(() => vi.unstubAllGlobals());

describe("newTopic", () => {
  it("is yantra- plus 26 base32 characters that ntfy accepts", () => {
    const topic = newTopic();
    expect(topic).toMatch(/^yantra-[a-z2-7]{26}$/);
    expect(topic).toMatch(/^[-_A-Za-z0-9]{1,64}$/);
  });

  it("differs between calls", () => {
    expect(newTopic()).not.toBe(newTopic());
  });

  it("is deterministic for fixed bytes", () => {
    const stub = (fill: number) =>
      vi.stubGlobal("crypto", {
        getRandomValues: (a: Uint8Array) => (a.fill(fill), a),
      });
    stub(0);
    expect(newTopic()).toBe(`yantra-${"a".repeat(26)}`);
    stub(255);
    expect(newTopic()).toBe(`yantra-${"7".repeat(25)}4`);
  });
});

describe("links", () => {
  it("builds the topic URL and the deep link", () => {
    expect(topicUrl("yantra-abc")).toBe("https://ntfy.sh/yantra-abc");
    expect(subscribeLink("yantra-abc")).toBe("ntfy://ntfy.sh/yantra-abc");
  });

  it("reads a topic only from the public server", () => {
    expect(publicTopic("https://ntfy.sh/yantra-abc")).toBe("yantra-abc");
    expect(publicTopic("https://example.com/yantra-abc")).toBeNull();
    expect(publicTopic("https://ntfy.sh/")).toBeNull();
  });
});
