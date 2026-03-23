FROM mcr.microsoft.com/playwright:v1.40.0-jammy

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Install Playwright browsers
RUN npx playwright install chromium

# Copy app code
COPY . .

# Expose port
EXPOSE 8080

# Start
CMD ["node", "scraper.js"]
