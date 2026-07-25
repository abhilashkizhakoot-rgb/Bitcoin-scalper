# Stage 1: Build the frontend and backend bundle
FROM node:20-alpine AS builder

WORKDIR /app

# Copy dependency files
COPY package.json package-lock.json ./

# Install all dependencies (including devDependencies)
RUN npm ci

# Copy the rest of the source code
COPY vite.config.ts tsconfig.json index.html server.ts ./
COPY src ./src

# Build the frontend and bundle the backend using production settings
ENV NODE_ENV=production
RUN npm run build

# Stage 2: Create the minimal production runner image
FROM node:20-alpine

WORKDIR /app

# Copy dependency files for production install
COPY package.json package-lock.json ./

# Install only production dependencies
RUN npm ci --only=production

# Copy compiled assets and server bundle from builder
COPY --from=builder /app/dist ./dist

# Create dedicated data directory for persistent volumes
RUN mkdir -p /app/data && chown -R node:node /app/data

# Use a non-root user for security
USER node

# Expose the port
EXPOSE 3000

# Environment variables
ENV PORT=3000
ENV NODE_ENV=production
ENV DATA_DIR=/app/data

# Command to start the application
CMD ["node", "dist/server.cjs"]
