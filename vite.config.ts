import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const packageJson = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };
const appVersion = getAppVersion();

function getAppVersion() {
  if (process.env.IONBRIDGE_WEB_VERSION) return process.env.IONBRIDGE_WEB_VERSION;
  try {
    return execSync("git describe --tags --always --dirty", { encoding: "utf8" }).trim();
  } catch {
    return packageJson.version;
  }
}

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  plugins: [
    react(),
    {
      name: "ionbridge-dynamic-device-proxy",
      configureServer(server) {
        server.middlewares.use("/device-proxy", async (req, res) => {
          try {
            const requestUrl = new URL(req.url ?? "/", "http://localhost");
            const target = requestUrl.searchParams.get("target");
            if (!target) {
              res.statusCode = 400;
              res.end("Missing target");
              return;
            }
            requestUrl.searchParams.delete("target");
            const targetUrl = new URL(`${requestUrl.pathname}${requestUrl.search}`, target);
            const response = await fetch(targetUrl);
            res.statusCode = response.status;
            response.headers.forEach((value, key) => {
              if (!["content-encoding", "content-length", "transfer-encoding"].includes(key.toLowerCase())) {
                res.setHeader(key, value);
              }
            });
            res.end(Buffer.from(await response.arrayBuffer()));
          } catch (error) {
            res.statusCode = 502;
            res.end(error instanceof Error ? error.message : "Proxy error");
          }
        });
      },
    },
  ],
  server: {
    port: 5174,
    proxy: {
      "/device": {
        target: "http://192.168.217.161",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/device/, ""),
      },
    },
  },
});
