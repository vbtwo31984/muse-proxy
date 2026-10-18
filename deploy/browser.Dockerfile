# Headless Chromium behind Playwright's run-server. Each client connection gets its
# own browser, closed when the connection ends, so nothing runs while idle.
# The playwright version must match playwright-core in package.json.
FROM mcr.microsoft.com/playwright:v1.64.0-noble
RUN npm install -g playwright@1.64.0 && npm cache clean --force
USER pwuser
EXPOSE 3000
CMD ["playwright", "run-server", "--port", "3000", "--host", "0.0.0.0"]
