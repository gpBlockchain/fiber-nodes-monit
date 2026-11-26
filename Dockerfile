FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-alpine
WORKDIR /app
RUN npm install -g tsx
COPY server/ server/
COPY --from=build /app/dist dist/
ENV HOST=0.0.0.0
ENV PORT=4173
EXPOSE 4173
CMD ["tsx", "server/prod.ts"]
