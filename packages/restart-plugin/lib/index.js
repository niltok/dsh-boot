const PRESENCE_PATH = "/dsh-boot/presence";
const RESTART_PATH = "/dsh-boot/restart";
const RESTART_HEADER = "x-dsh-boot-restart";
const SHUTDOWN_PATH = "/dsh-boot/shutdown";
const SHUTDOWN_HEADER = "x-dsh-boot-shutdown";

/** The dsh webserver service is required before this plugin registers routes. */
export const inject = ["webServer"];
export const name = "dsh-boot-restart";

function json(res, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (origin === void 0) return true;
  try {
    return new URL(origin).host === (req.headers.host ?? "");
  } catch {
    return false;
  }
}

async function forwardControl(res, controlPort, controlToken, path) {
  try {
    const upstream = await fetch(`http://127.0.0.1:${String(controlPort)}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-dsh-boot-token": controlToken,
      },
      body: "{}",
      signal: AbortSignal.timeout(8000),
    });
    const text = await upstream.text();
    let body = {};
    try {
      body = JSON.parse(text);
    } catch {
      // Keep the upstream raw diagnostic in the error path below.
    }
    if (!upstream.ok) {
      json(res, 502, { ok: false, error: body.error ?? `supervisor returned HTTP ${upstream.status}` });
      return;
    }
    json(res, upstream.status, body);
  } catch (error) {
    json(res, 502, {
      ok: false,
      error: `dsh-boot supervisor is unreachable: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

/**
 * Host half of the dsh-boot restart plugin.
 *
 * dsh-boot launches dsh with `--patch <generated overlay>`; this plugin is
 * added by that overlay only, so the user's profile and cordis.patch.yml are
 * never modified. When the plugin is loaded outside dsh-boot it reports
 * `enabled: false` and renders nothing in the browser.
 */
export function apply(ctx) {
  const controlPort = Number(process.env.DSH_BOOT_CONTROL_PORT ?? "");
  const controlToken = process.env.DSH_BOOT_CONTROL_TOKEN ?? "";
  const bootId = process.env.DSH_BOOT_START_ID ?? "";
  const enabled = Number.isInteger(controlPort) && controlPort > 0 && controlPort <= 65535 && controlToken.length > 0;

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: PRESENCE_PATH,
    handler: (req, res) => {
      if (req.method !== "GET" && req.method !== "HEAD") {
        json(res, 405, { ok: false, error: "method not allowed" });
        return;
      }
      json(res, 200, { ok: true, enabled, bootId, restartPath: RESTART_PATH, shutdownPath: SHUTDOWN_PATH });
    },
  }), "dsh-boot: presence route");

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: RESTART_PATH,
    handler: async (req, res) => {
      // Same-origin POST plus a custom header. A cross-origin page cannot
      // send the custom header without a CORS preflight, and this route
      // deliberately emits no CORS headers.
      if (req.method !== "POST") {
        json(res, 405, { ok: false, error: "POST required" });
        return;
      }
      if (req.headers[RESTART_HEADER] !== "yes" || !sameOrigin(req)) {
        json(res, 403, { ok: false, error: "forbidden" });
        return;
      }
      if (!enabled) {
        json(res, 503, { ok: false, error: "dsh was not started by dsh-boot" });
        return;
      }
      await forwardControl(res, controlPort, controlToken, "/restart");
    },
  }), "dsh-boot: restart route");

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: SHUTDOWN_PATH,
    handler: async (req, res) => {
      if (req.method !== "POST") {
        json(res, 405, { ok: false, error: "POST required" });
        return;
      }
      if (req.headers[SHUTDOWN_HEADER] !== "yes" || !sameOrigin(req)) {
        json(res, 403, { ok: false, error: "forbidden" });
        return;
      }
      if (!enabled) {
        json(res, 503, { ok: false, error: "dsh was not started by dsh-boot" });
        return;
      }
      await forwardControl(res, controlPort, controlToken, "/shutdown");
    },
  }), "dsh-boot: shutdown route");
}
