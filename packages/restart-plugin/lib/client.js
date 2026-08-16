window.__ModuleLoader__.load({
  id: "@dsh-boot/restart-plugin",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react_jsx_runtime = require("react/jsx-runtime");
    let react = require("react");

    const css = `
[data-dsh-boot="restart-row"],[data-dsh-boot="shutdown-row"]{box-sizing:border-box;display:flex;width:100%;align-items:center;justify-content:space-between;gap:16px;padding:16px 0;border-bottom:1px solid var(--dsw-alias-divider, rgba(127,127,127,.22))}
[data-dsh-boot="restart-row"]>[data-dsh-boot="text"],[data-dsh-boot="shutdown-row"]>[data-dsh-boot="text"]{min-width:0;flex:1 1 auto}
[data-dsh-boot="title"]{color:var(--dsw-alias-label-primary, inherit);font-size:14px;line-height:22px}
[data-dsh-boot="desc"]{color:var(--dsw-alias-label-secondary, inherit);font-size:12px;line-height:18px;margin-top:2px}
[data-dsh-boot="restart-button"],[data-dsh-boot="shutdown-button"]{box-sizing:border-box;flex:none;cursor:pointer;height:32px;border-radius:10px;border:1px solid var(--dsw-alias-border, rgba(127,127,127,.35));background:transparent;color:var(--dsw-alias-label-primary, inherit);padding:0 14px;font-family:inherit;font-size:13px;line-height:18px}
[data-dsh-boot="restart-button"]:hover,[data-dsh-boot="shutdown-button"]:hover{background:var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12))}
[data-dsh-boot="restart-button"]:disabled,[data-dsh-boot="shutdown-button"]:disabled{cursor:default;opacity:.6}
[data-dsh-boot="error"]{color:var(--dsw-alias-state-error-primary, #e5484d);font-size:12px;line-height:18px;margin-top:4px}
`;
    const styleTagId = "@dsh-boot/restart-plugin";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(styleTagId) + "]") === null) {
      const tag = document.createElement("style");
      tag.dataset.plugin = styleTagId;
      tag.dataset.pluginCss = styleTagId;
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    const NS = "dsh-boot";
    const inject = ["slots", "locale"];
    const zh = {
      title: "重启服务",
      description: "重启由 dsh-boot 托管的 DeepSeek Harness 服务。当前页面会断开，服务恢复后自动刷新。",
      restart: "重启服务",
      restarting: "正在重启…",
      shutdownTitle: "关闭服务",
      shutdownDescription: "停止由 dsh-boot 托管的 DeepSeek Harness 服务。关闭后可通过桌面图标或 dsh-boot start 重新启动。",
      shutdown: "关闭服务",
      shuttingDown: "正在关闭…",
      unavailable: "此 dsh 不是由 dsh-boot 启动的，重启/关闭入口不可用。",
      failed: "重启请求失败",
      shutdownFailed: "关闭请求失败",
    };
    const en = {
      title: "Restart service",
      description: "Restart the DeepSeek Harness service managed by dsh-boot. This page disconnects and reloads when the service is back.",
      restart: "Restart service",
      restarting: "Restarting…",
      shutdownTitle: "Shut down service",
      shutdownDescription: "Stop the DeepSeek Harness service managed by dsh-boot. You can start it again from the desktop icon or with dsh-boot start.",
      shutdown: "Shut down service",
      shuttingDown: "Shutting down…",
      unavailable: "This dsh instance was not started by dsh-boot, so restart/shutdown is unavailable.",
      failed: "Restart request failed",
      shutdownFailed: "Shutdown request failed",
    };

    function RestartRow({ t }) {
      const [state, setState] = react.useState({ status: "loading", error: null });
      const bootIdRef = react.useRef(undefined);

      react.useEffect(() => {
        let alive = true;
        const load = async () => {
          try {
            const response = await fetch("/dsh-boot/presence", { cache: "no-store" });
            if (!response.ok) throw new Error("presence unavailable");
            const body = await response.json();
            if (!alive) return;
            bootIdRef.current = body.bootId;
            setState({ status: body.enabled ? "ready" : "unavailable", error: null });
          } catch {
            if (alive) setState({ status: "unavailable", error: null });
          }
        };
        void load();
        return () => {
          alive = false;
        };
      }, []);

      if (state.status === "loading" || state.status === "unavailable") return null;

      const pollForNewBootId = (options = {}) => {
        let attempts = 0;
        const timer = window.setInterval(async () => {
          attempts += 1;
          try {
            const probe = await fetch("/dsh-boot/presence", { cache: "no-store" });
            if (probe.ok) {
              const body = await probe.json();
              if (body.bootId !== undefined && body.bootId !== bootIdRef.current) {
                window.clearInterval(timer);
                window.location.reload();
                return;
              }
              if (options.failAfterSameBootId !== undefined && attempts >= options.failAfterSameBootId) {
                window.clearInterval(timer);
                setState({ status: "ready", error: t("failed") });
                return;
              }
            }
          } catch {
            // The old server is down; keep polling.
          }
          if (attempts >= 45) {
            window.clearInterval(timer);
            window.location.reload();
          }
        }, 1000);
      };

      const restart = async () => {
        setState({ status: "restarting", error: null });
        try {
          const response = await fetch("/dsh-boot/restart", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-dsh-boot-restart": "yes",
            },
            body: "{}",
          });
          if (!response.ok) {
            let message = "";
            try {
              const body = await response.json();
              message = body.error ?? "";
            } catch {
              // Keep the generic message.
            }
            setState({ status: "ready", error: message || t("failed") });
            return;
          }

          // The supervisor replies 202 immediately and then replaces the dsh
          // process. Poll for the new boot id; when it appears the browser is
          // talking to the fresh server and can reload.
          pollForNewBootId();
        } catch {
          // The supervisor may have accepted the restart and killed dsh before
          // the HTTP response was delivered. Treat a transport failure as a
          // restart in progress and watch for the new boot id; only show the
          // generic error if the old server stays up with the same boot id.
          pollForNewBootId({ failAfterSameBootId: 5 });
        }
      };

      return react_jsx_runtime.jsxs("div", {
        "data-dsh-boot": "restart-row",
        children: [
          react_jsx_runtime.jsxs("div", {
            "data-dsh-boot": "text",
            children: [
              react_jsx_runtime.jsx("div", { "data-dsh-boot": "title", children: t("title") }),
              react_jsx_runtime.jsx("div", { "data-dsh-boot": "desc", children: t("description") }),
              state.error !== null && react_jsx_runtime.jsx("div", {
                "data-dsh-boot": "error",
                role: "alert",
                children: state.error,
              }),
            ],
          }),
          react_jsx_runtime.jsx("button", {
            type: "button",
            "data-dsh-boot": "restart-button",
            disabled: state.status === "restarting",
            onClick: () => void restart(),
            children: state.status === "restarting" ? t("restarting") : t("restart"),
          }),
        ],
      });
    }

    function ShutdownRow({ t }) {
      const [state, setState] = react.useState({ status: "loading", error: null });

      react.useEffect(() => {
        let alive = true;
        const load = async () => {
          try {
            const response = await fetch("/dsh-boot/presence", { cache: "no-store" });
            if (!response.ok) throw new Error("presence unavailable");
            const body = await response.json();
            if (!alive) return;
            setState({ status: body.enabled ? "ready" : "unavailable", error: null });
          } catch {
            if (alive) setState({ status: "unavailable", error: null });
          }
        };
        void load();
        return () => {
          alive = false;
        };
      }, []);

      if (state.status === "loading" || state.status === "unavailable") return null;

      const shutdown = async () => {
        setState({ status: "closing", error: null });
        try {
          const response = await fetch("/dsh-boot/shutdown", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-dsh-boot-shutdown": "yes",
            },
            body: "{}",
          });
          if (!response.ok) {
            let message = "";
            try {
              const body = await response.json();
              message = body.error ?? "";
            } catch {
              // Keep the generic message.
            }
            setState({ status: "ready", error: message || t("shutdownFailed") });
            return;
          }
          // Keep showing "正在关闭…"; the server is about to go away.
        } catch {
          // The supervisor may stop dsh before the HTTP response is delivered;
          // that is expected and should not be shown as a failure.
          setState({ status: "closing", error: null });
        }
      };

      return react_jsx_runtime.jsxs("div", {
        "data-dsh-boot": "shutdown-row",
        children: [
          react_jsx_runtime.jsxs("div", {
            "data-dsh-boot": "text",
            children: [
              react_jsx_runtime.jsx("div", { "data-dsh-boot": "title", children: t("shutdownTitle") }),
              react_jsx_runtime.jsx("div", { "data-dsh-boot": "desc", children: t("shutdownDescription") }),
              state.error !== null && react_jsx_runtime.jsx("div", {
                "data-dsh-boot": "error",
                role: "alert",
                children: state.error,
              }),
            ],
          }),
          react_jsx_runtime.jsx("button", {
            type: "button",
            "data-dsh-boot": "shutdown-button",
            disabled: state.status === "closing",
            onClick: () => void shutdown(),
            children: state.status === "closing" ? t("shuttingDown") : t("shutdown"),
          }),
        ],
      });
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-boot-restart: dictionaries");
      ctx.slots.inject("settings.general.item", () => ctx.slots.register({
        name: "settings.general.item",
        id: "dsh-boot-restart",
        order: 90,
        locale: NS,
      }, RestartRow));
      ctx.slots.inject("settings.general.item", () => ctx.slots.register({
        name: "settings.general.item",
        id: "dsh-boot-shutdown",
        order: 91,
        locale: NS,
      }, ShutdownRow));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
