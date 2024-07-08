import { EnvelopArmorPlugin } from "@escape.tech/graphql-armor";
import LocalforageCache from "@graphql-mesh/cache-localforage";
import useHive from "@graphql-mesh/plugin-hive";
import useMeshResponseCache from "@graphql-mesh/plugin-response-cache";
import { defineConfig } from "@graphql-mesh/serve-cli";
import { type MeshServeConfigContext } from "@graphql-mesh/serve-runtime";
import { PubSub } from "@graphql-mesh/utils";
import { useJWT } from "@graphql-yoga/plugin-jwt";
import packageInfo from "./package.json";

if (!process.env.UPSTREAM) {
  throw new Error("UPSTREAM is required");
}

const upstream = new URL(process.env.UPSTREAM);

if (!process.env.HIVE_TOKEN) {
  throw new Error("HIVE_TOKEN is required");
}

export const serveConfig = defineConfig({
  cache: new LocalforageCache(),
  pubsub: new PubSub(),
  landingPage: false,
  proxy: {
    endpoint: upstream.toString(),
    headers: (ctx) => {
      const headers = {};
      if (ctx?.context.request) {
        headers["Authorization"] =
          ctx.context.request.headers.get("Authorization");
          if(ctx.context.request.headers.get("x-hasura-admin-secret")) {
            headers["x-hasura-admin-secret"] = ctx.context.request.headers.get("x-hasura-admin-secret")
          }          
      } else {
        headers["x-hasura-admin-secret"] = process.env.HASURA_ADMIN_SECRET;
      }
      return headers;
    },
  },
  maskedErrors: false,
  plugins: (ctx) => {
    const armorLogger = ctx.logger.child("Armor");
    return [
      {
        async onRequest({ url, request, endResponse }) {
          // Try catch is important here, because exceptions are not caught by mesh in this hook
          try {
            if (shouldForwardToUpstream(url)) {
              endResponse(await forwardToUpstream(ctx, url, request));
            }
          } catch (e) {
            ctx.logger.error("Error while forwarding request to upstream:", e);
          }
        },
      },
      useJWT({
        algorithms: ["RS256"],
        issuer: "https://securetoken.google.com/ffxivteamcraft",
        audience: "ffxivteamcraft",
        jwksUri:
          "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com",
      }),
      useHive({
        ...ctx,
        logger: ctx.logger.child("Hive"),
        token: process.env.HIVE_TOKEN!,
        enabled: true,
        reporting: {
          author: packageInfo.author,
          commit: packageInfo.version,
        },
        usage: {
          clientInfo: {
            name: "ffxivteamcraft",
            version: packageInfo.version,
          },
          sampleRate: 0.1,
        },
      }),
      useMeshResponseCache({
        cache: ctx.cache!,
        includeExtensionMetadata: true,
        ttl: 10 * 60 * 1000,
        ignoredTypes: [
          "allagan_reports",
          "allagan_reports_aggregate",
          "allagan_reports_queue",
          "allagan_reports_queue_aggregate",
          "allagan_reports_queue_per_item",
          "bnpc"
        ],
        ttlPerCoordinate: [
          {
            coordinate: 'query_root.allagan_reports',
            ttl: 1
          },
          {
            coordinate: 'query_root.allagan_reports_queue',
            ttl: 1
          }
        ]
      }),
      EnvelopArmorPlugin({
        maxDepth: {
          n: 20,
          onReject: [armorLogger.error],
        },
        costLimit: {
          maxCost: 10000,
          depthCostFactor: 1,
          scalarCost: 0,
          onReject: [armorLogger.error],
        },
        maxAliases: {
          n: 110,
          allowList: [],
          onReject: [armorLogger.error],
        },
        maxDirectives: {
          onReject: [armorLogger.error],
        },
        maxTokens: {
          onReject: [armorLogger.error],
        },
      }),
    ];
  },
});

const hasuraPrefixes = ["/console", "/v1", "/v2"];
function shouldForwardToUpstream(url: URL): boolean {
  return (
    url.pathname === "/" ||
    hasuraPrefixes.some((prefix) => url.pathname.startsWith(prefix))
  );
}

const forwardRequestHeaders = [
  "cache-control",
  "content-type",
  "accept",
  "origin",
  "accept-encoding",
  "accept-language",
  "cookie",
  "x-request-id",
  "x-hasura-admin-secret",
  "authorization",
];
const forwardResponseHeaders = [
  "content-type",
  "set-cookie",
  "language",
  "date",
  "access-control-allow-origin",
  "access-control-allow-credentials",
  "access-control-allow-methods",
  "access-control-expose-headers",
  "x-request-id",
];
async function forwardToUpstream(
  ctx: MeshServeConfigContext,
  url: URL,
  request: Request
): Promise<Response> {
  if (
    url.pathname === "/v1/graphql" &&
    request.headers.get("x-hasura-admin-secret") !=
      process.env.HASURA_ADMIN_SECRET
  ) {
    ctx.logger.debug(
      "Upstream request to /v1/graphql without admin secret, denying."
    );
    return new Response("Unauthorized", { status: 401 });
  }

  const upstreamURL = upstream.origin + url.pathname ?? "" + url.search ?? "";
  ctx.logger.debug(
    `Forwarding request to upstream: ${request.method} ${url} => ${upstreamURL}`
  );
  const responseUpstream = await fetch(upstreamURL, {
    method: request.method,
    headers: [...request.headers.entries()].filter(([key]) =>
      forwardRequestHeaders.includes(key)
    ),
    body: request.body,
    // @ts-expect-error missing in types, required to forward body as readable stream
    duplex: "half",
  });

  return new Response(responseUpstream.body, {
    status: responseUpstream.status,
    statusText: responseUpstream.statusText,
    headers: [...responseUpstream.headers.entries()].filter(([key]) =>
      forwardResponseHeaders.includes(key)
    ),
  });
}
