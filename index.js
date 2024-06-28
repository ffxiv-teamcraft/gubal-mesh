import { EnvelopArmorPlugin } from "@escape.tech/graphql-armor";
import { http } from "@google-cloud/functions-framework";
import LocalforageCache from "@graphql-mesh/cache-localforage";
import useHive from "@graphql-mesh/plugin-hive";
import useMeshResponseCache from "@graphql-mesh/plugin-response-cache";
import { createServeRuntime } from "@graphql-mesh/serve-runtime";
import { PubSub } from "@graphql-mesh/utils";
import { useJWT } from "@graphql-yoga/plugin-jwt";
import packageInfo from "./package.json" with { type: "json" };

if (!process.env.HIVE_TOKEN) {
  throw new Error("HIVE_TOKEN is required");
}

if (!process.env.UPSTREAM) {
  throw new Error("UPSTREAM is required");
}

const meshHTTP = createServeRuntime({
  cache: new LocalforageCache(),
  pubsub: new PubSub(),
  landingPage: false,
  graphqlEndpoint: "/",
  proxy: {
    endpoint: process.env.UPSTREAM,
  },
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
        token: process.env.HIVE_TOKEN,
        enabled: true,
        reporting: {
          author: packageInfo.author,
          commit: packageInfo.version,
        },
        usage: {
          sampleRate: 0.1,
        },
      }),
      useMeshResponseCache({
        ...ctx,
        sessionId: null, // Global cache
        includeExtensionMetadata: true,
        ttl: 10 * 60 * 1000,
      }),
      EnvelopArmorPlugin({
        maxDepth: {
          n: 20,
          onReject: armorLogger.error,
        },
        costLimit: {
          maxCost: 10000,
          depthCostFactor: 1,
          scalarCost: 0,
          onReject: armorLogger.error,
        },
        maxAliases: {
          n: 110,
          allowList: [],
          onReject: armorLogger.error,
        },
        maxDirectives: {
          onReject: armorLogger.error,
        },
        maxTokens: {
          onReject: armorLogger.error,
        },
      }),
    ];
  },
});

http("graphql", meshHTTP);
