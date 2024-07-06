import { EnvelopArmorPlugin } from "@escape.tech/graphql-armor";
import LocalforageCache from "@graphql-mesh/cache-localforage";
import useHive from "@graphql-mesh/plugin-hive";
import useMeshResponseCache from "@graphql-mesh/plugin-response-cache";
import { defineConfig } from "@graphql-mesh/serve-cli";
import { PubSub } from "@graphql-mesh/utils";
import { useJWT } from "@graphql-yoga/plugin-jwt";
import packageInfo from "./package.json" with { type: "json" };

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
  // @ts-expect-error MeshConfig has a missing type union, you can actually provide an http handler
  landingPage: async ({ url, request }) => {
    if (
      url.pathname === "/v1/graphql" &&
      request.headers.get("x-hasura-admin-secret") !==
        process.env.HASURA_ADMIN_SECRET
    ) {
      return new Response("Unauthorized", { status: 401 });
    }

    return fetch(upstream.origin + url.pathname + url.search, {
      method: request.method,
      body: request.body,
      headers: Object.fromEntries(request.headers.entries()),
    });
  },
  proxy: {
    endpoint: upstream.toString(),
    headers: (ctx) => {
      const headers = {};
      if (ctx?.context.request) {
        headers["Authorization"] =
          ctx.context.request.headers.get("Authorization");
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
        ignoredTypes: ['allagan_reports', 'allagan_reports_aggregate', 'allagan_reports_queue', 'allagan_reports_queue_aggregate', 'allagan_reports_queue_per_item']
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
