import type { BrowserContext, Page } from "@playwright/test";

// Action popups are not exposed in context.pages(). Attach to the actual popup
// target instead of opening popup.html in a normal tab with unrelated sizing.
export async function openActionPopup(context: BrowserContext, extensionId: string, host: Page) {
  const cdp = await context.browser()!.newBrowserCDPSession();
  const tabs = await cdp.send("Target.getTargets", { filter: [{ type: "tab" }] });
  const tab = tabs.targetInfos.find((target) => target.url === host.url());
  if (!tab) throw new Error("Popup host tab not found");
  await cdp.send("Extensions.triggerAction", { id: extensionId, targetId: tab.targetId });
  const deadline = Date.now() + 5000;
  let targetId: string | undefined;
  while (!targetId && Date.now() < deadline) {
    const { targetInfos } = await cdp.send("Target.getTargets");
    targetId = targetInfos.find((target) => target.type === "page"
      && target.url === "chrome-extension://" + extensionId + "/popup.html")?.targetId;
    if (!targetId) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!targetId) throw new Error("Browser action popup did not open");
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: false });
  let next = 0;
  function command<T>(method: string, params: object = {}): Promise<T> {
    const id = ++next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error("Popup CDP timeout: " + method)), 5000);
      function finish(error?: Error, value?: T) {
        clearTimeout(timer);
        cdp.off("Target.receivedMessageFromTarget", receive);
        error ? reject(error) : resolve(value!);
      }
      function receive(event: { sessionId: string; message: string }) {
        if (event.sessionId !== sessionId) return;
        const reply = JSON.parse(event.message) as { id?: number; error?: { message: string }; result: T };
        if (reply.id === id) finish(reply.error ? new Error(reply.error.message) : undefined, reply.result);
      }
      cdp.on("Target.receivedMessageFromTarget", receive);
      void cdp.send("Target.sendMessageToTarget", { sessionId, message: JSON.stringify({ id, method, params }) })
        .catch((error: Error) => finish(error));
    });
  }
  return {
    async evaluate<T>(expression: string): Promise<T> {
      const reply = await command<{ result: { value: T }; exceptionDetails?: { text: string } }>("Runtime.evaluate",
        { expression, returnByValue: true, awaitPromise: true });
      if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.text);
      return reply.result.value;
    },
    async screenshot() {
      const { data } = await command<{ data: string }>("Page.captureScreenshot", { format: "png" });
      return Buffer.from(data, "base64");
    },
    async close() {
      await cdp.send("Target.closeTarget", { targetId: targetId! }).catch(() => {});
      await cdp.detach();
    },
  };
}
