FROM theguild/graphql-mesh:v1

COPY package.json /app/package.json
COPY package-lock.json /app/package-lock.json

RUN npm ci --production

COPY mesh.config.ts /app/mesh.config.ts
