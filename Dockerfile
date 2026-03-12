FROM node:20-alpine

# Install build dependencies for any native modules if needed
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (only production if needed, but we need some devDeps for build if any)
RUN npm install --omit=dev

# Copy all files (respecting .gitignore)
COPY . .

# Environment variables
ENV PORT=3000
ENV NODE_ENV=production

# Expose the port
EXPOSE 3000

# Start the server
CMD ["node", "server.js"]
